// Qualifies the installed CLI through real processes and isolated local state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, '.build', 'cli-refusals', randomUUID());
const home = join(directory, 'home');
const state = join(directory, 'state');
mkdirSync(home, { recursive: true });
mkdirSync(state, { recursive: true });
const project = join(directory, 'project');
mkdirSync(project);
writeFileSync(join(project, 'README.md'), '# Retained import qualification\n');
const report = { status: 'failed', commands: [], started_at: new Date().toISOString() };
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, '\t'));
function required(name) {
  const value = process.env[name];
  assert.ok(value?.trim(), `${name} is required`);
  return value;
}
async function command(binary, args) {
  const record = { binary, args, stdout: '', stderr: '' };
  report.commands.push(record);
  save();
  const environment = { ...process.env, HOME: home, XDG_STATE_HOME: state };
  delete environment.STADO_INTEGRATION_API_URL;
  delete environment.KRONIKA_STADO_INTEGRATION_TOKEN;
  const child = spawn(binary, args, {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
    record[stream] += chunk;
    save();
  });
  await new Promise((resolveExit, reject) => {
    child.once('error', error => { record.error = error.message; reject(error); });
    child.once('close', (code, signal) => {
      record.exit = code;
      record.signal = signal;
      resolveExit();
    });
  });
  save();
  return record;
}
try {
  const success = Number(required('KRONIKA_TEST_SUCCESS_EXIT'));
  const usage = Number(required('KRONIKA_TEST_USAGE_EXIT'));
  assert.ok(Number.isSafeInteger(success) && Number.isSafeInteger(usage) && success !== usage);
  const revision = await command('git', ['rev-parse', 'HEAD']);
  assert.equal(revision.exit, success, revision.stderr);
  assert.equal(revision.stdout.trim(), required('KRONIKA_TEST_SOURCE_REVISION'));
  report.source_revision = revision.stdout.trim();
  const site = join(root, 'pipeline', 'src', 'run.mjs');
  report.site_entry_sha256 = createHash('sha256').update(readFileSync(site)).digest('hex');
  const siteHelp = await command(process.execPath, [site, '--help']);
  assert.equal(siteHelp.signal, null, siteHelp.stderr);
  assert.equal(siteHelp.exit, success, siteHelp.stderr);
  assert.equal(siteHelp.stderr, '');
  assert.ok(siteHelp.stdout.includes('kronika-site') && siteHelp.stdout.includes('--sources'),
    siteHelp.stdout);
  const siteCases = [
    { args: ['--unknown-option'], field: '--unknown-option' },
    { args: ['--sources'], field: '--sources' },
    { args: [project], field: '--sources' },
  ];
  for (const item of siteCases) {
    const result = await command(process.execPath, [site, ...item.args]);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.exit, usage, result.stderr);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.error, 'usage');
    assert.ok(failure.detail.includes(item.field), failure.detail);
    assert.equal(existsSync(join(project, 'kronika.sync.json')), false,
      'site usage refusal changed the product workspace');
    assert.equal(existsSync(join(state, 'kronika', 'onboarding.json')), false,
      'site usage refusal created onboarding state');
  }
  const binary = resolve(required('KRONIKA_TEST_CLI_BIN'));
  report.binary_sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  const cases = [
    { args: ['check'], names: ['--base'] },
    { args: ['check', '--base', '--json'], names: ['--base'] },
    { args: ['check', '--base', ' '], names: ['--base'] },
    { args: ['check', '--apply'], names: ['check', '--apply'] },
    { args: ['sources', '--model', 'any'], names: ['sources', '--model'] },
    { args: ['gui', '--json'], names: ['gui', '--json'] },
    { args: ['onboarding', '--repo', root], names: ['onboarding', '--repo'] },
    { args: ['sync', '--push'], names: ['--push', '--commit'] },
    { args: ['onboarding', '--reset', '--status'], names: ['--reset', '--status'] },
    { args: ['onboarding', '--status', '--reset'], names: ['--status', '--reset'] },
    { args: ['onboarding', '--advance', '--advance'], names: ['--advance'] },
    { args: ['onboarding', '--skip', '--reset'], names: ['--skip', '--reset'] },
  ];
  for (const item of cases) {
    const result = await command(binary, item.args);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.exit, usage, result.stderr);
    for (const name of item.names) assert.ok(result.stderr.includes(name), result.stderr);
    assert.equal(existsSync(join(state, 'kronika', 'onboarding.json')), false,
      'refused invocation created onboarding state');
  }
  const help = await command(binary, ['check', '--help']);
  assert.equal(help.signal, null, help.stderr);
  assert.equal(help.exit, success, help.stderr);
  assert.ok(help.stdout.includes('--base'), help.stdout);
  report.onboarding_state_created = existsSync(join(state, 'kronika', 'onboarding.json'));
  assert.equal(report.onboarding_state_created, false);
  const operational = Number(required('KRONIKA_TEST_OPERATIONAL_EXIT'));
  assert.ok(Number.isSafeInteger(operational) && operational !== success && operational !== usage);
  const started = await command(binary, ['onboarding', '--json']);
  assert.equal(started.signal, null, started.stderr);
  assert.equal(started.exit, success, started.stderr);
  const statePath = join(state, 'kronika', 'onboarding.json');
  const original = readFileSync(statePath);
  const saved = JSON.parse(original);
  assert.equal(typeof saved.installation_id, 'string');
  assert.ok(saved.installation_id.trim(), 'real onboarding did not persist its identity');
  // No control plane is configured here, so the shipped journey runs and the
  // view says why, instead of falling back without a word.
  const startedView = JSON.parse(started.stdout);
  assert.ok(startedView.controlPlaneFailures.some(failure =>
    failure.includes("the control plane's journey bundle could not be used: onboarding control plane is unavailable")),
  started.stdout);
  assert.ok(startedView.controlPlaneFailures.some(failure => failure.includes('the shipped journey runs')), started.stdout);
  const rendered = await command(binary, ['onboarding', '--status']);
  assert.equal(rendered.exit, success, rendered.stderr);
  assert.ok(rendered.stdout.includes('Control plane: the control plane\'s journey bundle could not be used'), rendered.stdout);
  const retained = [
    { bytes: '{', field: 'JSON' },
    ...[
      ['installation_id', null],
      ['installation_id', ''],
      ['pending_events', {}],
      ['evidence', []],
      ['meta', []],
    ].map(([field, value]) => ({
      bytes: JSON.stringify({ ...saved, [field]: value }),
      field,
    })),
  ];
  for (const item of retained) {
    writeFileSync(statePath, item.bytes);
    const before = readFileSync(statePath);
    const result = await command(binary, ['onboarding', '--status', '--json']);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.exit, operational, result.stderr);
    assert.ok(result.stderr.includes(statePath) && result.stderr.includes(item.field), result.stderr);
    assert.deepEqual(readFileSync(statePath), before, 'refusal rewrote retained onboarding state');
  }
  writeFileSync(statePath, original);
  const recovered = await command(binary, ['onboarding', '--status', '--json']);
  assert.equal(recovered.signal, null, recovered.stderr);
  assert.equal(recovered.exit, success, recovered.stderr);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).installation_id, saved.installation_id);
  report.retained_state_sha256 = createHash('sha256').update(original).digest('hex');
  writeFileSync(statePath, '{');
  const imported = await command(binary, ['init', '--repo', project, '--json']);
  assert.equal(imported.exit, success, imported.stderr);
  const accepted = JSON.parse(imported.stdout);
  assert.equal(accepted.status, 'imported');
  assert.equal(accepted.onboarding.completed, false);
  assert.ok(accepted.onboarding.error.includes(statePath) && accepted.onboarding.error.includes('JSON'),
    JSON.stringify(accepted.onboarding));
  const manifestPath = join(project, 'kronika.sync.json');
  const acceptedBytes = readFileSync(manifestPath);
  assert.equal(readFileSync(statePath, 'utf8'), '{', 'successful import must not overwrite damaged onboarding');
  writeFileSync(statePath, original);
  const importRecovery = await command(binary, ['init', '--repo', project, '--json']);
  assert.equal(importRecovery.exit, success, importRecovery.stderr);
  const repeated = JSON.parse(importRecovery.stdout);
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.onboarding.error, undefined);
  assert.deepEqual(readFileSync(manifestPath), acceptedBytes, 'recovery must preserve accepted import');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).installation_id, saved.installation_id);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  save();
  console.log(join(directory, 'report.json'));
}
