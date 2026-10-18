// Real CLI-launched graphical server and HTTP import, without a browser engine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function required(name) {
  const value = process.env[name];
  assert.ok(value?.trim(), `${name} is required`);
  return value;
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(required('KRONIKA_TEST_CLI_BIN'));
const revision = required('KRONIKA_TEST_SOURCE_REVISION');
const success = Number(required('KRONIKA_TEST_SUCCESS_EXIT'));
assert.ok(Number.isSafeInteger(success));
const root = join(repository, '.build', 'retained-manifest', randomUUID());
const project = join(root, 'project');
const home = join(root, 'home');
await mkdir(project, { recursive: true });
await mkdir(home);
await writeFile(join(project, 'README.md'), '# Retained manifest qualification\n');
const environment = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, 'state') };
delete environment.STADO_INTEGRATION_API_URL;
delete environment.KRONIKA_STADO_INTEGRATION_TOKEN;
const report = { revision, binary, commands: [], requests: [], cleanupErrors: [], verdict: 'failed' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function launch(program, args) {
  const record = { program, args, stdout: '', stderr: '', errors: [] };
  report.commands.push(record);
  const child = spawn(program, args, { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { record.stdout += chunk; });
  child.stderr.on('data', chunk => { record.stderr += chunk; });
  child.stdout.on('error', error => record.errors.push(String(error)));
  child.stderr.on('error', error => record.errors.push(String(error)));
  child.on('error', error => record.errors.push(String(error)));
  const closed = new Promise(resolve => child.once('close', (exit, signal) => {
    Object.assign(record, { exit, signal });
    resolve(record);
  }));
  return { child, record, closed };
}
let server;
try {
  const head = await launch('git', ['rev-parse', 'HEAD']).closed;
  assert.equal(head.exit, success, head.stderr);
  assert.equal(head.stdout.trim(), revision);
  const clean = await launch('git', ['status', '--porcelain']).closed;
  assert.equal(clean.exit, success, clean.stderr);
  assert.equal(clean.stdout, '', 'commit the product and qualification source first');
  report.binarySha256 = hash(await readFile(binary));
  server = launch(binary, ['gui', '--repo', project]);
  const session = await new Promise((resolveSession, reject) => {
    server.child.once('error', reject);
    server.child.stdout.on('error', reject);
    server.child.stdout.on('data', () => {
      const prefix = 'Kronika graphical importer: ';
      const line = server.record.stdout.split('\n').find(value => value.startsWith(prefix));
      if (line && server.record.stdout.endsWith('\n')) resolveSession(new URL(line.slice(prefix.length)));
    });
    server.closed.then(record => reject(new Error(`GUI exited before readiness: ${JSON.stringify(record)}`)));
  });
  const token = new URLSearchParams(session.hash.slice('#'.length)).get('token');
  assert.ok(token, 'server omitted the actual session token');
  const manifest = join(project, 'kronika.sync.json');
  async function importing() {
    const body = { manifestPath: 'kronika.sync.json', documents: ['README.md'], sources: ['README.md'], replace: false };
    const response = await fetch(new URL('/api/import', session), { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kronika-Token': token, Origin: session.origin },
      body: JSON.stringify(body) });
    const text = await response.text();
    report.requests.push({ path: '/api/import', body, status: response.status, response: text });
    return { ok: response.ok, body: JSON.parse(text) };
  }
  const baseline = await importing();
  assert.equal(baseline.ok, true, JSON.stringify(baseline));
  assert.equal(baseline.body.result.status, 'imported');
  const original = await readFile(manifest);
  assert.deepEqual(baseline.body.project, JSON.parse(original));
  report.manifestSha256 = hash(original);

  await writeFile(manifest, '{');
  const malformed = await importing();
  assert.equal(malformed.ok, false);
  assert.equal(malformed.body.project, undefined, 'unreadable retained project is not an absent project');
  assert.ok(malformed.body.error.includes(manifest) && malformed.body.error.includes('JSON'), JSON.stringify(malformed));
  assert.equal(await readFile(manifest, 'utf8'), '{');
  await rm(manifest);
  await symlink(manifest, manifest);
  const loop = await importing();
  assert.equal(loop.ok, false);
  assert.ok(loop.body.error.includes(manifest) && loop.body.error.includes('ELOOP'), JSON.stringify(loop));
  await assert.rejects(readFile(manifest), { code: 'ELOOP' });
  await rm(manifest);
  await mkdir(manifest);
  const directory = await importing();
  assert.equal(directory.ok, false);
  assert.ok(directory.body.error.includes(manifest) && directory.body.error.includes('EISDIR'), JSON.stringify(directory));
  await rm(manifest, { recursive: true });
  await writeFile(manifest, original);
  const recovered = await importing();
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.body.result.status, 'unchanged');
  assert.deepEqual(recovered.body.project, baseline.body.project);
  assert.deepEqual(await readFile(manifest), original);
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), '# Retained manifest qualification\n');
  report.verdict = 'passed';
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  if (server) {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGTERM');
    const stopped = await server.closed;
    if (stopped.errors.length) { report.processErrors = stopped.errors; report.verdict = 'failed'; }
  }
  for (const owned of [project, home]) {
    try { await rm(owned, { recursive: true }); }
    catch (error) { report.cleanupErrors.push(String(error)); report.verdict = 'failed'; }
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, '\t'));
}
assert.equal(report.verdict, 'passed', JSON.stringify(report));
