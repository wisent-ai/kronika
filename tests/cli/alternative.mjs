// Brama is one alternative of Kronika's model service, not a precondition.
// The real author stage runs with BRAMA_URL unset and the real Stado
// KRONIKA_TEST_STADO names as `stado`, in a home where no service directory
// places Brama. With no other alternative declared it is refused naming Brama
// and the endpoint alternative; with an OpenAI-compatible endpoint declared in
// Brama's place, that endpoint is the one asked, for its own model, and Stado
// records it as the one that served Kronika. The endpoint answers the chat
// with 502, so the stage stops there naming the endpoint it asked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, '.build', 'cli-alternative', randomUUID());
const home = join(directory, 'home');
const bin = join(directory, 'bin');
const repo = join(directory, 'repo');
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'README.md'), '# Example\n\nAn example product.\n');
const brief = join(directory, 'brief.json');
writeFileSync(brief, JSON.stringify({
  repo, product: 'example', surfaces: { cli: { ok: false } },
  docs: { readme: { ok: true, path: join(repo, 'README.md') } },
}));
const standard = join(directory, 'standard.md');
writeFileSync(standard, '# Writing standard\n\nPlain sentences.\n');
const report = { status: 'failed', commands: [], asked: [], started_at: new Date().toISOString() };
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, '\t'));

const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    report.asked.push({ method: request.method, url: request.url, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'endpoint-model', object: 'model' }] }));
      return;
    }
    response.statusCode = 502;
    response.end(JSON.stringify({ error: { message: 'endpoint-under-test-unavailable' } }));
  });
});

async function author(extra) {
  const record = { extra, stdout: '', stderr: '' };
  report.commands.push(record);
  save();
  const environment = { ...process.env, ...extra, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  for (const name of ['BRAMA_URL', 'STADO_CAPABILITIES_RECORD']) delete environment[name];
  const child = spawn(process.execPath, [
    join(root, 'pipeline', 'src', 'stages', 'author.mjs'),
    '--brief', brief, '--standard', standard, '--repo', repo, '--out', join(directory, 'plan.json'),
  ], { cwd: join(root, 'pipeline'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { record[stream] += chunk; });
  await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => { record.exit = code; resolveExit(); });
  });
  save();
  return record;
}

try {
  const stado = process.env.KRONIKA_TEST_STADO;
  assert.ok(stado?.trim(), 'KRONIKA_TEST_STADO names the real stado executable');
  symlinkSync(stado, join(bin, 'stado'));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const unanswered = await author({});
  assert.notEqual(unanswered.exit, 0, unanswered.stdout);
  const said = `${unanswered.stdout}${unanswered.stderr}`;
  assert.match(said, /no inference alternative answers: brama at [^;]+; model-endpoint at /, said);
  assert.equal(report.asked.length, 0, 'no endpoint is declared, so none is asked');

  const served = await author({
    STADO_INFERENCE_ENDPOINT_URL: origin,
    STADO_INFERENCE_ENDPOINT_MODEL: 'endpoint-model',
  });
  assert.notEqual(served.exit, 0, served.stdout);
  const chats = report.asked.filter(item => item.method === 'POST' && item.url === '/v1/chat/completions');
  assert.ok(chats.length > 0, `the endpoint itself was asked: ${JSON.stringify(report.asked)}`);
  for (const chat of chats) assert.equal(JSON.parse(chat.body).model, 'endpoint-model');
  assert.ok(`${served.stdout}${served.stderr}`.includes(origin), served.stdout);
  const record = readFileSync(join(home, '.stado', 'capabilities.json'), 'utf8');
  assert.match(record, /model-endpoint/);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  save();
  console.log(join(directory, 'report.json'));
}
