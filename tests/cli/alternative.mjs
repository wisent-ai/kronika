// Brama is one alternative of Kronika's model service, not a precondition,
// and Kronika names none: with BRAMA_URL unset, each request is handed to
// `stado capabilities call inference --consumer kronika`. The real author
// stage runs with the real Stado KRONIKA_TEST_STADO names as `stado`, in a
// home where no service directory places Brama. Nothing answers first: the
// stage stops with the model infrastructure down, naming Brama and the command
// that answers the kept request. The statement recorded for that request then
// answers it: the stage writes the plan it carries, and Stado records the
// attestation alternative as the one that served Kronika.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const planPath = join(directory, 'plan.json');
const report = { status: 'failed', commands: [], started_at: new Date().toISOString() };
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, '\t'));
const environment = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
for (const name of ['BRAMA_URL', 'STADO_CAPABILITIES_RECORD', 'STADO_ATTESTATIONS', 'STADO_INFERENCE_ORDER', 'STADO_CONFIG']) delete environment[name];

function stado(args, input) {
  const output = execFileSync('stado', args, { env: environment, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  report.commands.push({ program: 'stado', args });
  save();
  return output;
}

async function author() {
  const record = { stdout: '', stderr: '' };
  report.commands.push(record);
  save();
  const child = spawn(process.execPath, [
    join(root, 'pipeline', 'src', 'stages', 'author.mjs'),
    '--brief', brief, '--standard', standard, '--repo', repo, '--out', planPath,
  ], { cwd: join(root, 'pipeline'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { record[stream] += chunk; });
  const { promise, resolve: exited, reject } = Promise.withResolvers();
  child.once('error', reject);
  child.once('close', code => { record.exit = code; exited(); });
  await promise;
  save();
  return record;
}

try {
  const real = process.env.KRONIKA_TEST_STADO;
  assert.ok(real?.trim(), 'KRONIKA_TEST_STADO names the real stado executable');
  symlinkSync(real, join(bin, 'stado'));
  stado(['config', 'init']);

  const unanswered = await author();
  assert.equal(unanswered.exit, 69, `${unanswered.stdout}${unanswered.stderr}`);
  const said = `${unanswered.stdout}${unanswered.stderr}`;
  assert.match(said, /brama at /, said);
  assert.match(said, /stado capabilities attestation record inference --consumer kronika/, said);

  const kept = JSON.parse(stado(['capabilities', 'attestation', 'list', 'inference', '--consumer', 'kronika', '--json']));
  assert.equal(kept.length, 1, JSON.stringify(kept));
  const shown = JSON.parse(stado(['capabilities', 'attestation', 'show', 'inference', '--consumer', 'kronika', kept[0].request]));
  assert.equal(shown.asked.tool_choice.function.name, 'documentation_plan');
  // The statement is the strict answer schema's own skeleton: required keys,
  // empty lists. It reaches Kronika as the model's answer, and Kronika holds
  // it to the whole plan schema, whose bounds the strict answer schema does
  // not carry, so the stage is decided by the statement: invalid_plan, not
  // the infrastructure down.
  const schema = shown.asked.tools[0].function.parameters;
  const sample = (node) => {
    if (node.enum) return node.enum[0];
    if (node.anyOf) return null;
    switch (node.type) {
      case 'object': return Object.fromEntries((node.required ?? []).map((key) => [key, sample(node.properties[key])]));
      case 'array': return [];
      case 'string': return 'example';
      case 'boolean': return false;
      default: throw new Error(`the answer schema holds a node this case does not answer: ${JSON.stringify(node)}`);
    }
  };
  stado(['capabilities', 'attestation', 'record', 'inference', '--consumer', 'kronika', kept[0].request,
    '--checked', 'built the plan from the schema the request carries'], JSON.stringify(sample(schema)));

  const answered = await author();
  assert.equal(answered.exit, 1, `${answered.stdout}${answered.stderr}`);
  const refusal = JSON.parse(answered.stdout || answered.stderr);
  assert.equal(refusal.error, 'invalid_plan', JSON.stringify(refusal));
  assert.deepEqual(refusal.schemaErrors.map((error) => error.path), ['$.pages']);
  assert.ok(readFileSync(join(home, '.stado', 'capabilities.json'), 'utf8').includes('"provider": "attestation"'), 'Stado records attestation serving kronika');
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  rmSync(home, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  save();
  console.log(join(directory, 'report.json'));
}
