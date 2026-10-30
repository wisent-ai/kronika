// Starts Kronika the way its quick start does, from this checkout: build it
// with npm run build, then run node dist/src/cli.js init, sources and gui
// against an isolated project. Every way that startup is refused is run as a
// real process, and each refusal must name what failed, why, and the fix.
//
//   KRONIKA_TEST_SOURCE_REVISION=<sha> KRONIKA_TEST_SUCCESS_EXIT=0 \
//   KRONIKA_TEST_USAGE_EXIT=2 KRONIKA_TEST_OPERATIONAL_EXIT=1 \
//   node tests/startup/cli.mjs
//
// The report (every command, its output and exit) is written to
// .build/startup/<uuid>/report.json and its path printed last.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, '.build', 'startup', randomUUID());
const home = join(directory, 'home');
const state = join(directory, 'state');
const project = join(directory, 'project');
const missing = join(directory, 'no-such-repository');
const locked = join(directory, 'locked');
for (const path of [home, state, project]) mkdirSync(path, { recursive: true });
writeFileSync(join(project, 'README.md'), '# Startup qualification\n');
const cli = join(root, 'dist', 'src', 'cli.js');
const report = { status: 'failed', commands: [], unreproduced: [], started_at: new Date().toISOString() };
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, '\t'));
function required(name) {
  const value = process.env[name];
  assert.ok(value?.trim(), `${name} is required`);
  return value;
}
// Kronika runs with isolated state and without any credential, control plane
// or git location the caller's shell carries, so every refusal below is its
// own and the project's git is the project's.
const isolated = { ...process.env, HOME: home, XDG_STATE_HOME: state };
for (const name of ['BRAMA_URL', 'BRAMA_API_KEY_ROLE', 'WISENT_APP_AGENT_ID', 'WISENT_APP_AGENT_AUTH_SECRET_ROLE',
  'KRONIKA_CREDENTIALS_FILE', 'KRONIKA_MODEL', 'STADO_INTEGRATION_API_URL', 'KRONIKA_STADO_INTEGRATION_TOKEN_ROLE',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete isolated[name];
}
function launch(binary, args, environment = isolated) {
  const record = { binary, args, stdout: '', stderr: '' };
  report.commands.push(record);
  save();
  const child = spawn(binary, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { record[stream] += chunk; });
  const { promise: closed, resolve: resolveClosed, reject } = Promise.withResolvers();
  child.once('error', error => { record.error = error.message; reject(error); });
  child.once('close', (code, signal) => {
    record.exit = code;
    record.signal = signal;
    save();
    resolveClosed(record);
  });
  return { child, record, closed };
}
const command = (binary, args, environment) => launch(binary, args, environment).closed;
// What binding `port` on loopback answers for this user: 'free' or the code.
async function bindOutcome(port) {
  const probe = createServer();
  const { promise, resolve: settled } = Promise.withResolvers();
  probe.once('error', error => settled(error.code));
  probe.listen(port, '127.0.0.1', () => probe.close(() => settled('free')));
  return promise;
}
let server;
let occupant;
try {
  const success = Number(required('KRONIKA_TEST_SUCCESS_EXIT'));
  const usage = Number(required('KRONIKA_TEST_USAGE_EXIT'));
  const operational = Number(required('KRONIKA_TEST_OPERATIONAL_EXIT'));
  assert.ok([success, usage, operational].every(Number.isSafeInteger));
  assert.equal(new Set([success, usage, operational]).size, 3, 'the three exit statuses must differ');
  // The files run are exactly the named revision: nothing tracked differs
  // from it and nothing untracked is added. This holds in a checkout at that
  // revision and in an export of it read through GIT_DIR and GIT_WORK_TREE.
  const source = required('KRONIKA_TEST_SOURCE_REVISION');
  const revision = await command('git', ['rev-parse', '--verify', `${source}^{commit}`], process.env);
  assert.equal(revision.exit, success, revision.stderr);
  report.source_revision = revision.stdout.trim();
  const changed = await command('git', ['diff', '--name-status', report.source_revision, '--'], process.env);
  assert.equal(changed.exit, success, changed.stderr);
  assert.equal(changed.stdout, '', `the files run differ from ${report.source_revision}`);
  const added = await command('git', ['ls-files', '--others', '--exclude-standard'], process.env);
  assert.equal(added.exit, success, added.stderr);
  assert.equal(added.stdout, '', `files outside ${report.source_revision} are present`);

  // The quick start's build: the step that failed when Kronika did not start.
  const build = await command('npm', ['run', 'build'], process.env);
  assert.equal(build.signal, null, build.stderr);
  assert.equal(build.exit, success, `npm run build failed:\n${build.stdout}\n${build.stderr}`);
  report.cli_sha256 = createHash('sha256').update(readFileSync(cli)).digest('hex');

  const help = await command(process.execPath, [cli, '--help']);
  assert.equal(help.exit, success, help.stderr);
  assert.ok(help.stdout.includes('kronika init'), help.stdout);
  // The project is a repository of its own, as the quick start's is.
  const repository = await command('git', ['init', '--quiet', project]);
  assert.equal(repository.exit, success, repository.stderr);
  const init = await command(process.execPath, [cli, 'init', '--repo', project, '--json']);
  assert.equal(init.exit, success, init.stderr);
  const imported = JSON.parse(init.stdout);
  assert.equal(imported.accepted, true, init.stdout);
  assert.deepEqual(imported.imported, ['README.md']);
  const sources = await command(process.execPath, [cli, 'sources', '--repo', project, '--json']);
  assert.equal(sources.exit, success, sources.stderr);
  assert.ok(JSON.parse(sources.stdout).sources.some(({ path }) => path === 'README.md'), sources.stdout);

  // The graphical workspace starts, prints its session URL and answers it.
  server = launch(process.execPath, [cli, 'gui', '--repo', project]);
  const prefix = 'Kronika graphical importer: ';
  const { promise: ready, resolve: announced, reject: died } = Promise.withResolvers();
  server.child.stdout.on('data', () => {
    const line = server.record.stdout.split('\n').find(value => value.startsWith(prefix));
    if (line && server.record.stdout.endsWith('\n')) announced(new URL(line.slice(prefix.length)));
  });
  server.closed.then(record => died(new Error(`gui exited before printing its URL: ${JSON.stringify(record)}`)));
  const session = await ready;
  const token = new URLSearchParams(session.hash.slice(1)).get('token');
  assert.ok(token, session.href);
  const config = await fetch(new URL('/api/config', session), { headers: { 'X-Kronika-Token': token } });
  assert.equal(config.status, 200);
  const configBody = await config.json();
  report.gui_config = configBody;
  assert.equal(resolve(configBody.repo), resolve(project));

  // Usage refusals: exit with the usage status, the refusal above the help.
  // Each names what was refused (`what`), why (`why`) and the fix (`fix`).
  const usageCases = [
    { args: ['bogus'], what: 'Unknown command: bogus', why: 'is none of check, write, sources, sync, init, gui, onboarding', fix: 'put one of' },
    { args: ['--repo', project], what: 'Unknown command: --repo', why: 'came before any command', fix: 'put one of' },
    { args: ['check'], what: 'check requires --base <ref>', why: 'no change to audit', fix: '--base origin/main' },
    { args: ['check', '--base'], what: '--base requires a value', why: 'last word of the command line', fix: '--base <value>' },
    { args: ['check', '--base', '--json'], what: '--base requires a value', why: 'is the option --json', fix: 'before --json' },
    { args: ['check', '--base', ' '], what: '--base requires a value', why: 'empty or only whitespace', fix: 'non-blank value' },
    { args: ['sources', '--max-input-bytes', 'many'], what: '--max-input-bytes must be a positive integer', why: '"many" is not a number', fix: '1 or more' },
    { args: ['sources', '--max-input-bytes', '1.5'], what: '--max-input-bytes must be a positive integer', why: 'not a whole number', fix: '1 or more' },
    { args: ['sources', '--max-file-bytes', '0'], what: '--max-file-bytes must be a positive integer', why: 'is zero', fix: '1 or more' },
    { args: ['sources', '--max-file-bytes', '-3'], what: '--max-file-bytes must be a positive integer', why: 'is negative', fix: '1 or more' },
    { args: ['sources', '--max-file-bytes', '9007199254740993'], what: '--max-file-bytes must be a positive integer', why: 'larger than 9007199254740991', fix: '1 or more' },
    { args: ['gui', '--port', '70000'], what: '--port must be between 1 and 65535', why: '16-bit', fix: 'leave --port out' },
    { args: ['sources', '--apply'], what: 'sources does not accept --apply', why: '--apply belongs to write', fix: 'sources accepts --repo' },
    { args: ['sources', '--aply'], what: 'sources does not accept --aply', why: 'no kronika command has an option --aply', fix: 'check its spelling' },
    { args: ['sources', 'README.md'], what: 'sources does not accept README.md', why: 'is not an option', fix: 'right after the option it is for' },
    { args: ['onboarding', '--skip', '--reset'], what: '--skip conflicts with --reset', why: 'exactly one of', fix: 'its own kronika onboarding command' },
    { args: ['sync', '--push'], what: 'sync --push requires --commit', why: 'makes no commit', fix: 'add --commit' },
  ];
  for (const item of usageCases) {
    const result = await command(process.execPath, [cli, ...item.args]);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.exit, usage, `${item.args.join(' ')}: ${result.stderr}`);
    const [refusal] = result.stderr.split('\n');
    for (const part of [item.what, item.why, item.fix]) assert.ok(refusal.includes(part), `${item.args.join(' ')} lacks ${part}: ${refusal}`);
    assert.ok(result.stderr.includes('Usage:'), result.stderr);
  }

  // Operational refusals of a well-formed startup: the failure status, no help.
  const file = join(project, 'README.md');
  occupant = createServer();
  const { promise: held, resolve: holding } = Promise.withResolvers();
  occupant.listen(0, '127.0.0.1', holding);
  await held;
  const occupied = occupant.address().port;
  const loop = join(directory, 'loop');
  symlinkSync(loop, loop);
  // One path component longer than any filesystem here admits (255 bytes on
  // APFS, ext4 and NTFS), so the operating system refuses the name itself.
  const long = join(directory, 'n'.repeat(256));
  const operationalCases = [
    { args: ['sources', '--repo', loop], what: `Repository ${loop} (from --repo) cannot be used`, why: 'a loop of symbolic links (ELOOP)', fix: 'pass --repo' },
    { args: ['sources', '--repo', long], what: 'cannot be used', why: 'longer than this system allows (ENAMETOOLONG)', fix: 'pass --repo' },
    { args: ['sources', '--repo', missing], what: `Repository ${missing} (from --repo) cannot be used`, why: 'nothing exists at that path (ENOENT)', fix: 'pass --repo the path of an existing repository directory' },
    { args: ['sources', '--repo', join(file, 'below')], what: 'cannot be used', why: 'is a file, not a directory (ENOTDIR)', fix: 'pass --repo the path of an existing repository directory' },
    { args: ['sources', '--repo', file], what: `Repository is not a directory: ${file}`, why: 'is a file', fix: 'not a file inside it' },
    { args: ['gui', '--repo', missing], what: `Repository ${missing} (from --repo) cannot be used`, why: '(ENOENT)', fix: 'pass --repo' },
    { args: ['gui', '--repo', project, '--port', String(occupied)], what: `cannot listen on 127.0.0.1:${occupied}`, why: 'another process already listens there (EADDRINUSE)', fix: 'pass another --port' },
    { args: ['write', '--repo', project], what: 'BRAMA_URL is required', why: 'is not set', fix: 'export BRAMA_URL=' },
    { args: ['write', '--repo', project], env: { BRAMA_URL: '' }, what: 'BRAMA_URL is required', why: 'set but empty', fix: 'kronika sources' },
    { args: ['check', '--repo', project, '--base', 'HEAD'], env: { BRAMA_URL: 'http://127.0.0.1:1' }, what: 'BRAMA_API_KEY_ROLE is required', why: 'is not set, so no bearer can be read', fix: 'KRONIKA_CREDENTIALS_FILE' },
  ];
  // A directory this user may not search refuses a lookup below it, except
  // for a user the permission bits do not bind (root); that is recorded as
  // not reproducible here instead of passing without running.
  mkdirSync(locked);
  chmodSync(locked, 0);
  const lockedOutcome = (() => {
    try { statSync(join(locked, 'repository')); return 'readable'; }
    catch (error) { return error.code; }
  })();
  if (lockedOutcome === 'EACCES') {
    operationalCases.push({ args: ['sources', '--repo', join(locked, 'repository')], what: 'cannot be used', why: 'may not look up a directory on that path (EACCES)', fix: 'pass --repo' });
  } else {
    report.unreproduced.push({ case: 'sources --repo <below an unsearchable directory> (EACCES)', reason: `a lookup below a mode-0 directory answered ${lockedOutcome} for this user` });
  }
  // A privileged port is refused only where this user may not bind it; where
  // it may (root, or a system that grants low ports), the case is recorded as
  // not reproducible here instead of passing without running.
  const privileged = [1023, 1022, 1021];
  let refusedPort;
  for (const port of privileged) {
    const outcome = await bindOutcome(port);
    if (outcome === 'EACCES') { refusedPort = port; break; }
  }
  if (refusedPort === undefined) {
    report.unreproduced.push({ case: 'gui --port <privileged> (EACCES)', reason: `this user may bind loopback ports ${privileged.join(', ')}` });
  } else {
    operationalCases.push({ args: ['gui', '--repo', project, '--port', String(refusedPort)], what: `cannot listen on 127.0.0.1:${refusedPort}`, why: 'refused this user that port (EACCES)', fix: 'pass a --port of 1024 or more' });
  }
  for (const item of operationalCases) {
    const result = await command(process.execPath, [cli, ...item.args], { ...isolated, ...item.env });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.exit, operational, `${item.args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '', `${item.args.join(' ')} printed a result: ${result.stdout}`);
    assert.ok(result.stderr.startsWith('kronika: '), result.stderr);
    for (const part of [item.what, item.why, item.fix]) assert.ok(result.stderr.includes(part), `${item.args.join(' ')} lacks ${part}: ${result.stderr}`);
    assert.ok(!result.stderr.includes('Usage:'), result.stderr);
  }
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  if (server && server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await server.closed;
  }
  if (occupant) await new Promise(closed => occupant.close(closed));
  rmSync(home, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  rmSync(join(directory, 'loop'), { force: true });
  try { chmodSync(locked, 0o700); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  rmSync(locked, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  save();
  console.log(join(directory, 'report.json'));
}
