// Reuses test/helpers.mjs fixture and F05 slow-Git patterns; retains every fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
const self = fileURLToPath(import.meta.url);
const here = path.resolve(process.env.WORKFLOW_BENCH_AREA || '.local/bench-080');
const variants = {
  release070: path.resolve(process.env.WORKFLOW_BENCH_BASELINE || path.join(here, 'baseline')),
  installed070: path.resolve(process.env.WORKFLOW_BENCH_INSTALLED || path.join(process.env.LOCALAPPDATA, 'workflow/current')),
  source080: path.resolve(process.env.WORKFLOW_BENCH_SOURCE || '.')
};
const mode = process.argv[2];
function runNode(args, options = {}, onData) {
  const start = performance.now();
  const child = spawn(process.execPath, args, { windowsHide: true, ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; onData?.(String(d)); });
  child.stdin.end(options.input || '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, ms: performance.now() - start, stdout, stderr }); });
  });
}
function lastJSON(text) { try { return JSON.parse(text.trim().split(/\r?\n/).at(-1)); } catch { return null; } }
function receipt(output) { const t = output?.hookSpecificOutput?.additionalContext || ''; return t.startsWith('workflow 回执：') ? JSON.parse(t.slice('workflow 回执：'.length)) : null; }
if (mode === 'lock') {
  const { withLock } = await import(pathToFileURL(path.join(variants[process.argv[3]], 'src/store.mjs')));
  const start = performance.now();
  try { await withLock(process.argv[4], 'state', async () => {}, { budgetMs: 1200 }); console.log(JSON.stringify({ acquired: true, waitMs: performance.now() - start })); }
  catch (e) { console.log(JSON.stringify({ acquired: false, waitMs: performance.now() - start, error: e.code })); }
} else if (mode === 'sample') {
  const [variant, scenario] = process.argv.slice(3);
  const root = variants[variant];
  let entry;
  const load = name => import(pathToFileURL(path.join(root, 'src', name + '.mjs')));
  const { enableProject } = await load('projects');
  const { getContext } = await load('context');
  const { handleHook } = await load('hooks');
  const { mutate } = await load('store');
  const area = await fs.mkdtemp(path.join(here, 'fixture-'));
  const project = path.join(area, 'project'), directory = path.join(area, 'state');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'README.md'), '# benchmark\n');
  const spec = scenario.includes('spec') && !scenario.includes('no-spec');
  function git(args) { const r = spawnSync('git', ['-C', project, '-c', 'user.name=benchmark', '-c', 'user.email=benchmark@example.invalid', ...args], { encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(r.stderr); }
  if (spec) {
    git(['init', '-b', 'main']);
    await fs.mkdir(path.join(project, 'src'));
    await fs.mkdir(path.join(project, '.spec/app'), { recursive: true });
    await fs.writeFile(path.join(project, 'src/app.mjs'), 'export const app = 1;\n');
    await fs.writeFile(path.join(project, '.spec/app/spec.md'), '---\ncode:\n  - src/app.mjs\n---\n# app\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'seed spec']);
  }
  await enableProject(directory, project, { owner: 'bench-session' });
  const files = [];
  const { RELEASE_PATHS } = await load('install');
  const releaseRoot = path.join(area, 'release');
  await fs.mkdir(releaseRoot);
  for (const relative of RELEASE_PATHS) {
    await fs.mkdir(path.dirname(path.join(releaseRoot, relative)), { recursive: true });
    await fs.cp(path.join(root, relative), path.join(releaseRoot, relative), { recursive: true });
  }
  entry = path.join(releaseRoot, 'bin/workflow.mjs');
  async function walk(relative) {
    const info = await fs.lstat(path.join(root, relative));
    if (info.isDirectory()) for (const name of await fs.readdir(path.join(root, relative))) await walk(path.join(relative, name));
    else files.push({ path: relative.replaceAll('\\', '/'), hash: createHash('sha256').update(await fs.readFile(path.join(root, relative))).digest('hex') });
  }
  for (const relative of RELEASE_PATHS) await walk(relative);
  files.sort((a, b) => a.path.localeCompare(b.path));
  await mutate(directory, async state => { state.install = { status: 'installed', releaseRoot, files }; });
  const base = { cwd: project, session_id: 'bench-session', turn_id: 'bench-turn', permission_mode: 'default' };
  const hook = e => handleHook(directory, { ...base, ...e }, { entry, synthetic: true });
  await hook({ hook_event_name: 'UserPromptSubmit' });
  let identity = (await getContext(directory, project, 'lead', 'bench-session')).identity;
  const signalEvent = payload => ({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` }, tool_response: { output: JSON.stringify({ workflow_signal: payload }) } });
  if (scenario !== 'prompt' && scenario !== 'posttool') {
    const out = await hook(signalEvent({ ...identity, taskId: 'bench-task', signalId: 'start', action: 'task-start', route: 'lead-direct', goal: 'benchmark', permissions: { mode: 'write', allowedPaths: ['README.md', 'src/app.mjs'] } }));
    if (!receipt(out)?.accepted) throw new Error(JSON.stringify(out));
    identity = (await getContext(directory, project, 'lead', 'bench-session')).identity;
  }
  let event;
  if (scenario === 'prompt') event = { ...base, hook_event_name: 'UserPromptSubmit', turn_id: 'next-turn' };
  else if (scenario === 'posttool') event = { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, tool_response: {} };
  else if (scenario.startsWith('stop')) event = { ...base, hook_event_name: 'Stop' };
  else event = signalEvent({ ...identity, taskId: 'bench-task', signalId: randomUUID(), action: 'task-end' });
  const slow = scenario.includes('slow') || scenario.includes('hang');
  let competitor = null;
  const result = await runNode([...(slow ? ['--import', pathToFileURL(path.join(path.dirname(self), 'version-080-slow-git.mjs')).href] : []), entry, 'hook', '--state-dir', directory, '--agent', 'codex'], {
    input: JSON.stringify(event), env: { ...process.env, BENCH_DELAY: scenario.includes('hang') ? 'hang' : '350' }
  }, text => { if (slow && text.includes('SPEC-BEGIN') && !competitor) competitor = runNode([self, 'lock', variant, directory]); });
  const output = lastJSON(result.stdout), r = receipt(output);
  const lock = competitor ? lastJSON((await competitor).stdout) : null;
  const success = result.code === 0 && (scenario.startsWith('end') ? (scenario.includes('hang') ? r?.accepted === false && r?.reason === 'GATE' : r?.accepted === true) : scenario.startsWith('stop') ? output?.decision === 'block' : !!output && !output.systemMessage);
  console.log(JSON.stringify({ variant, scenario, ms: result.ms, success, receipt: r, decision: output?.decision, lock, files: files.length, error: success ? null : { stdout: result.stdout, stderr: result.stderr, code: result.code } }));
} else {
  const rows = [];
  const firstRound = Number(process.argv[3] || 0);
  const lastRound = Number(process.argv[4] || 9);
  const scenarios = ['prompt', 'posttool', 'stop-no-spec', 'end-no-spec', 'stop-spec', 'end-spec'];
  for (let round = firstRound; round < lastRound; round++) {
    const order = round % 2 ? Object.keys(variants).reverse() : Object.keys(variants);
    for (const scenario of scenarios) for (const variant of order) {
      const r = await runNode([self, 'sample', variant, scenario]);
      const value = lastJSON(r.stdout); if (!value) throw new Error(r.stderr || r.stdout);
      rows.push({ round, ...value });
    }
    await fs.writeFile(path.join(here, `raw-${firstRound}-${lastRound}.json`), JSON.stringify(rows, null, 2));
    console.log(`normal round ${round + 1}/9`);
  }
  for (const scenario of (lastRound === 9 ? ['end-spec-slow', 'end-spec-hang'] : [])) for (let round = 0; round < (scenario.includes('hang') ? 1 : 3); round++) for (const variant of (round % 2 ? Object.keys(variants).reverse() : Object.keys(variants))) {
    const r = await runNode([self, 'sample', variant, scenario]);
    const value = lastJSON(r.stdout); if (!value) throw new Error(r.stderr || r.stdout);
    rows.push({ round, ...value });
    await fs.writeFile(path.join(here, `raw-${firstRound}-${lastRound}.json`), JSON.stringify(rows, null, 2));
    console.log(`${variant} ${scenario}: ${value.ms.toFixed(1)}ms success=${value.success} lock=${JSON.stringify(value.lock)}`);
  }
  console.log(JSON.stringify({ samples: rows.length, failures: rows.filter(r => !r.success) }));
}
