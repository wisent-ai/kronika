// Uses a genuine product repository, its live binary, and its authored plan.
// No command responder or model provider is simulated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, '.build', 'coverage', randomUUID());
mkdirSync(directory, { recursive: true });
const report = { status: 'failed', commands: [], started_at: new Date().toISOString() };
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, '\t'));
function required(name) {
  const value = process.env[name];
  assert.ok(value?.trim(), `${name} is required`);
  return value;
}
async function command(binary, args, cwd = root) {
  const record = { binary, args, cwd, stdout: '', stderr: '' };
  report.commands.push(record);
  save();
  const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { record[stream] += chunk; });
  await new Promise((resolveExit, reject) => {
    child.once('error', error => { record.error = error.message; reject(error); });
    child.once('close', (code, signal) => { record.exit = code; record.signal = signal; resolveExit(); });
  });
  save();
  return record;
}
const planPath = join(directory, 'plan.json');
const briefPath = join(directory, 'brief.json');
try {
  const success = Number(required('KRONIKA_TEST_SUCCESS_EXIT'));
  const failure = Number(required('KRONIKA_TEST_FAILURE_EXIT'));
  assert.ok(Number.isSafeInteger(success) && Number.isSafeInteger(failure) && success !== failure);
  const revision = await command('git', ['rev-parse', 'HEAD']);
  assert.equal(revision.exit, success, revision.stderr);
  assert.equal(revision.stdout.trim(), required('KRONIKA_TEST_SOURCE_REVISION'));
  report.source_revision = revision.stdout.trim();
  const repo = resolve(required('KRONIKA_TEST_PRODUCT_REPO'));
  const productRevision = await command('git', ['rev-parse', 'HEAD'], repo);
  assert.equal(productRevision.exit, success, productRevision.stderr);
  report.product_revision = productRevision.stdout.trim();
  const planBytes = readFileSync(required('KRONIKA_TEST_PLAN'));
  const briefBytes = readFileSync(required('KRONIKA_TEST_BRIEF'));
  report.plan_sha256 = createHash('sha256').update(planBytes).digest('hex');
  report.brief_sha256 = createHash('sha256').update(briefBytes).digest('hex');
  const plan = JSON.parse(planBytes);
  const brief = JSON.parse(briefBytes);
  assert.equal(brief.product, plan.product);
  assert.ok(brief.surfaces.cli.binary, 'Fixture must declare a real CLI binary');
  report.product_binary_sha256 = createHash('sha256').update(readFileSync(brief.surfaces.cli.binary)).digest('hex');
  writeFileSync(planPath, planBytes);
  writeFileSync(briefPath, briefBytes);
  const args = [join(root, 'pipeline/src/stages/validate.mjs'), '--repo', repo, '--plan', planPath, '--brief', briefPath];
  const baseline = await command(process.execPath, args);
  assert.equal(baseline.exit, success, baseline.stderr);
  assert.equal(JSON.parse(baseline.stdout).ok, true, baseline.stdout);
  const slug = required('KRONIKA_TEST_REQUIRED_COMMAND_PAGE');
  assert.ok(plan.pages.some(page => page.slug === slug && page.kind === 'cli-reference'));
  const missing = structuredClone(plan);
  missing.pages = missing.pages.filter(page => page.slug !== slug && !page.slug.startsWith(`${slug}/`));
  writeFileSync(planPath, JSON.stringify(missing));
  const refused = await command(process.execPath, args);
  assert.equal(refused.exit, failure, refused.stderr);
  const missingReport = JSON.parse(refused.stdout);
  assert.equal(missingReport.ok, false);
  assert.equal(missingReport.validators.find(item => item.validator === 'coverage')?.pass, false);
  writeFileSync(planPath, planBytes);
  const unavailable = structuredClone(brief);
  unavailable.surfaces.cli.binary = join(directory, 'absent-product-binary');
  writeFileSync(briefPath, JSON.stringify(unavailable));
  const unavailableResult = await command(process.execPath, args);
  assert.equal(unavailableResult.exit, failure, unavailableResult.stderr);
  const unavailableReport = JSON.parse(unavailableResult.stdout);
  assert.equal(unavailableReport.ok, false);
  assert.equal(unavailableReport.validators.find(item => item.validator === 'coverage')?.pass, false);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  const cleanupErrors = [];
  for (const path of [planPath, briefPath]) {
    try { rmSync(path, { force: true }); }
    catch (error) {
      cleanupErrors.push(error);
      (report.cleanup_errors ??= []).push({ path, cause: error.stack });
    }
  }
  if (cleanupErrors.length) report.status = 'failed';
  report.finished_at = new Date().toISOString();
  save();
  console.log(join(directory, 'report.json'));
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, `Coverage cleanup failed; original result retained in ${join(directory, 'report.json')}`);
  }
}
