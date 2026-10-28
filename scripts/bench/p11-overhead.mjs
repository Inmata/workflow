#!/usr/bin/env node
// P11 运行开销测量：入口/信号/Stop 的发布校验、知识检索与对齐检查、状态写入、锁归档和预检。
// 口径：同一台机器、系统临时目录里的合成状态；进程内测量和真实 CLI 子进程分开；每场景 9 次取中位数。
// I/O 次数用进程内对 node:fs/promises 与 node:crypto 的计数包装得到，不引入第三方依赖。
// 所有状态、项目、发布副本都在临时目录；CLI 一律显式 --state-dir，不读写真实宿主配置或状态目录。
// 结束时用 trash 清理临时目录。--entry 指向另一个版本（例如基线 worktree）即可复用同一脚本做对比。
import path from 'node:path';
import os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultEntry = path.join(path.resolve(here, '../..'), 'bin', 'workflow.mjs');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const entry = path.resolve(option('entry', defaultEntry));
const runs = Number(option('runs', '9'));
const asJSON = process.argv.includes('--json');
const src = path.resolve(path.dirname(entry), '..', 'src');
const load = name => import(pathToFileURL(path.join(src, name)).href);

// —— I/O 计数：包装 CJS 导出后同步到 ESM 命名导入，目标版本的源码无需改动 ——
const counters = { calls: {}, bytes: {} };
let counting = false;
for (const name of ['readFile', 'writeFile', 'readdir', 'lstat', 'stat', 'open', 'rename', 'mkdir', 'realpath', 'copyFile', 'symlink', 'unlink', 'access', 'cp']) {
  const original = fsp[name];
  if (typeof original !== 'function') continue;
  fsp[name] = async function (...args) {
    if (counting) counters.calls[name] = (counters.calls[name] || 0) + 1;
    const result = await original.apply(this, args);
    if (counting && name === 'readFile') counters.bytes.readFile = (counters.bytes.readFile || 0) + (typeof result === 'string' ? Buffer.byteLength(result) : result?.length || 0);
    return result;
  };
}
const originalCreateHash = crypto.createHash;
crypto.createHash = (...args) => {
  if (counting) counters.calls.createHash = (counters.calls.createHash || 0) + 1;
  return originalCreateHash(...args);
};
syncBuiltinESMExports();

function begin() {
  counting = true;
  counters.calls = {};
  counters.bytes = {};
}
function end() {
  counting = false;
  return { calls: { ...counters.calls }, bytes: { ...counters.bytes } };
}

// —— 目标版本的源码 ——
const { handleHook } = await load('hooks.mjs');
const { enableProject } = await load('projects.mjs');
const { getContext } = await load('context.mjs');
const { mutate, readState, digest } = await load('store.mjs');
const { verifyRelease } = await load('install.mjs');
const { selectKnowledge, renderEntry } = await load('learning.mjs');
const { inspectAlignment, scanAlignment } = await load('alignment.mjs');
const { preflight } = await load('runner.mjs');

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sumCalls = snapshot => Object.values(snapshot.calls).reduce((sum, value) => sum + value, 0);

async function measure(label, operation, { runs: count = runs, prepare } = {}) {
  const times = [];
  let snapshot = { calls: {}, bytes: {} }, chars = 0;
  for (let index = 0; index < count; index++) {
    if (prepare) await prepare(index);
    begin();
    const started = performance.now();
    const output = await operation(index);
    const finished = performance.now();
    snapshot = end();
    times.push(finished - started);
    chars = output === undefined ? 0 : JSON.stringify(output).length;
  }
  return { label, median: median(times), min: Math.min(...times), max: Math.max(...times), times, calls: snapshot.calls, ioCalls: sumCalls(snapshot), readBytes: snapshot.bytes.readFile || 0, chars };
}

const areas = [];
async function setupArea(prefix) {
  const area = await fsp.mkdtemp(path.join(os.tmpdir(), `workflow-p11-${prefix}-`));
  areas.push(area);
  return area;
}
async function copyDirectory(from, to) {
  await fsp.cp(from, to, { recursive: true });
}
const scratch = (fixture, label) => path.join(fixture.area, `${label}-${crypto.randomUUID()}`);

// 合成发布副本：规模接近当前仓库的 RELEASE_PATHS（约 47 个文件、617 KB）。
async function makeRelease(area) {
  const root = path.join(area, 'release');
  const plan = [
    ['bin', 1, 20000], ['hooks', 2, 3000], ['src', 19, 20000],
    ['docs/roles', 6, 8000], ['docs/references', 4, 6000], ['docs/adapters', 3, 5000],
    ['docs/design', 2, 12000], ['examples', 2, 6000],
  ];
  const files = [];
  for (const [folder, count, size] of plan) for (let index = 0; index < count; index++) files.push([`${folder}/file-${String(index).padStart(2, '0')}.mjs`, size]);
  for (const [name, size] of [['package.json', 800], ['plugin.json', 200], ['README.md', 30000], ['README.en.md', 34000]]) files.push([name, size]);
  files.push(['docs/workflow.md', 9000], ['docs/alignment.md', 7000], ['docs/usage.md', 6000], ['docs/learning.md', 6000], ['docs/background-review.md', 6000], ['docs/acceptance.md', 5000], ['docs/design/protocol.md', 20000]);
  const inventory = [];
  for (const [relative, size] of files) {
    const content = `${relative}\n${'x'.repeat(Math.max(0, size - relative.length - 1))}\n`;
    const file = path.join(root, ...relative.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
    inventory.push({ path: relative, hash: digest(content) });
  }
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files: inventory };
}

async function makeKnowledge(project, count) {
  const folder = path.join(project, '.workflow', 'knowledge');
  await fsp.mkdir(folder, { recursive: true });
  for (let index = 0; index < count; index++) {
    const id = `knowledge-${String(index).padStart(4, '0')}`;
    const value = {
      schemaVersion: 1, id, status: 'active', type: 'method', importance: index % 17 === 0 ? 'important' : 'normal',
      maturity: 'verified', title: `合成经验 ${index}`, summary: `关于构建与测试的第 ${index} 条合成经验`,
      conditions: `适用条件 ${index}`, scope: { paths: ['src/alpha.mjs'] }, tags: ['bench', `topic-${index % 10}`],
      evidence: [{ kind: 'success', verified: true, incidentId: `incident-${index}`, summary: '合成证据' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await fsp.writeFile(path.join(folder, `${id}.md`), renderEntry(value));
  }
  return folder;
}

async function makeAlignmentProject(project) {
  for (let index = 0; index < 300; index++) {
    const file = path.join(project, 'src', `file-${String(index).padStart(3, '0')}.md`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `# 合成资料 ${index}\n${'内容'.repeat(20)}\n`);
  }
}

// 入口 hook 的种子状态：接入项目、写入安装记录、建立回合、task-start、可选预热入口。
async function makeHookFixture(prefix, { release, knowledge = 0, warm = false, alignment = false } = {}) {
  const area = await setupArea(prefix);
  const project = path.join(area, 'project');
  await fsp.mkdir(project);
  await fsp.writeFile(path.join(project, 'README.md'), '# 项目\n');
  if (knowledge) await makeKnowledge(project, knowledge);
  if (alignment) await makeAlignmentProject(project);
  const seed = path.join(area, 'seed');
  await enableProject(seed, project, { owner: 'bench-session' });
  await mutate(seed, async state => {
    // 合成安装记录：verifyRelease 会按它逐文件读取并哈希发布副本。
    state.install = { status: 'installed', version: 'bench', releaseRoot: release.root, files: release.files };
    const record = Object.values(state.projects)[0];
    // changedAt 抑制“尚未启用后台学习”的长提示，避免输出字符数被无关文案放大。
    record.learning = { ...(record.learning || {}), enabled: false, changedAt: '2026-01-01T00:00:00.000Z' };
  });
  const sessionId = 'bench-session';
  await hook(seed, { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: sessionId, turn_id: 'turn-1', permission_mode: 'default' });
  const context = await getContext(seed, project, 'lead', sessionId);
  const payload = { ...context.identity, taskId: 'bench-task', signalId: 'signal-seed', action: 'task-start', route: 'lead-direct', goal: 'P11 基准任务：测量入口与知识检索开销', permissions: { mode: 'write', allowedPaths: ['src/alpha.mjs'] } };
  await hook(seed, signalEvent(payload, 'evt-seed'), { cwd: project });
  if (warm) await hook(seed, { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: sessionId, turn_id: 'turn-2', permission_mode: 'default' });
  const identity = (await getContext(seed, project, 'lead', sessionId)).identity;
  return { area, project, seed, identity, sessionId };
}

const signalEvent = (payload, eventId) => ({
  hook_event_name: 'PostToolUse', tool_name: 'Bash',
  tool_input: { command: `node "${entry}" signal --base64 e30=` },
  tool_response: { output: JSON.stringify({ workflow_signal: payload }) },
  event_id: eventId,
});

async function hook(directory, event, options = {}) {
  return handleHook(directory, { cwd: options.cwd || null, session_id: 'bench-session', turn_id: 'turn-1', permission_mode: 'default', ...event }, { synthetic: false, entry });
}

// 每次测量都从同一份种子状态复制；复制与预热放在计时/计数之外。
function measureHook(label, fixture, event, options = {}) {
  let directory = null;
  return measure(label, () => hook(directory, event, { ...options, cwd: event.cwd || options.cwd || fixture.project }), {
    prepare: async () => {
      directory = scratch(fixture, label);
      await copyDirectory(fixture.seed, directory);
      if (options.before) await options.before(directory);
    },
  });
}

function measureOnCopy(label, fixture, operation) {
  let directory = null;
  return measure(label, () => operation(directory), {
    prepare: async () => {
      directory = scratch(fixture, label);
      await copyDirectory(fixture.seed, directory);
    },
  });
}

function report(rows, notes) {
  if (asJSON) {
    console.log(JSON.stringify({ entry, runs, rows, notes }, null, 2));
    return;
  }
  console.log(`entry=${entry}`);
  console.log(`runs=${runs}（每场景中位数；io 为 readFile/readdir/lstat/stat/open/rename/mkdir/createHash 等调用总和）`);
  for (const row of rows) {
    const keys = ['readFile', 'readdir', 'lstat', 'stat', 'open', 'rename', 'mkdir', 'createHash', 'writeFile'];
    const calls = keys.filter(key => row.calls?.[key]).map(key => `${key}=${row.calls[key]}`).join(' ');
    console.log(`${row.label.padEnd(36)} median=${row.median.toFixed(2).padStart(8)}ms min=${row.min.toFixed(2).padStart(7)} max=${row.max.toFixed(2).padStart(7)} io=${String(row.ioCalls).padStart(4)} bytes=${String(row.readBytes).padStart(9)} chars=${String(row.chars).padStart(6)}  ${calls}`);
  }
  for (const note of notes) console.log(note);
}

// —— 场景 ——
const rows = [];
const notes = [];
const area = await setupArea('main');
const release = await makeRelease(area);

// 1. 发布副本完整性校验：直接调用与各 hook 入口。
rows.push(await measure('verifyRelease-direct', () => verifyRelease({ releaseRoot: release.root, files: release.files })));

{
  const fixture = await makeHookFixture('hook-plain', { release });
  rows.push(await measureHook('hook-posttool-normal', fixture, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(fixture.project, 'README.md') }, tool_response: {} }));
  const outside = path.join(fixture.area, 'outside');
  await fsp.mkdir(outside, { recursive: true });
  rows.push(await measureHook('hook-entry-unregistered', fixture, { hook_event_name: 'UserPromptSubmit', session_id: 'other-session', turn_id: 'turn-x', permission_mode: 'default' }, { cwd: outside }));
  rows.push(await measureHook('hook-stop', fixture, { hook_event_name: 'Stop', turn_id: 'turn-1' }));
  const warm = await makeHookFixture('hook-warm', { release, warm: true });
  rows.push(await measureHook('hook-entry-registered', warm, { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-3', permission_mode: 'default' }));
  const payload = { ...warm.identity, taskId: 'bench-task', signalId: 'signal-measured', action: 'phase', phase: 'delivering', deliveryId: 'delivery-1' };
  rows.push(await measureHook('hook-signal', warm, { ...signalEvent(payload, 'evt-measured'), turn_id: warm.identity.turnId }));
}

// 2. unchanged 前的知识检索与对齐逐项检查。
for (const size of [20, 300]) {
  const fixture = await makeHookFixture(`knowledge-${size}`, { release, knowledge: size, warm: true });
  const prompt = { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-3', permission_mode: 'default' };
  rows.push(await measureHook(`hook-entry-nochange-${size}`, fixture, prompt));
  rows.push(await measureOnCopy(`knowledge-select-warm-${size}`, fixture, directory => selectKnowledge(directory, fixture.project, { text: 'P11 基准任务：测量入口与知识检索开销', paths: ['src/alpha.mjs'] })));
  // 单文件内容变化：改写一个知识文件（大小也变化，明确越过缓存签名），每个副本仍带旧索引。
  const changed = path.join(fixture.project, '.workflow', 'knowledge', 'knowledge-0000.md');
  const original = await fsp.readFile(changed, 'utf8');
  await fsp.writeFile(changed, `${original}\n附加变化：合成内容 ${Date.now()}\n`);
  rows.push(await measureHook(`hook-entry-changed-${size}`, fixture, prompt));
  rows.push(await measureOnCopy(`knowledge-select-changed-${size}`, fixture, directory => selectKnowledge(directory, fixture.project, { text: 'P11 基准任务：测量入口与知识检索开销', paths: ['src/alpha.mjs'] })));
  await fsp.writeFile(changed, original);
}

{
  const fixture = await makeHookFixture('alignment', { release, alignment: true });
  await scanAlignment(fixture.seed, fixture.project);
  const state = await readState(fixture.seed);
  const project = Object.values(state.projects)[0];
  const alignment = project.alignment;
  rows.push(await measure('alignment-inspect-300', () => inspectAlignment({ ...project, alignment })));
  notes.push(`alignment-inspect-300: 索引含 ${alignment.files.length} 个文件、${alignment.directories.length} 个目录`);
}

// 3. 状态写入：不同规模的无操作 mutate，以及重放事件。
for (const size of [10_000, 500_000, 5_000_000]) {
  const directory = path.join(area, `mutate-${size}`);
  await mutate(directory, async () => {});
  const state = await readState(directory);
  for (let index = 0; Object.keys(state.pending).length * 1000 < size; index++) state.pending[`filler-${index}`] = { kind: 'bench-filler', payload: 'x'.repeat(1000) };
  await fsp.writeFile(path.join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  rows.push(await measure(`mutate-noop-${Math.round(size / 1000)}k`, () => mutate(directory, async () => {})));
}

{
  const fixture = await makeHookFixture('replay', { release, warm: true });
  const event = { ...signalEvent({ ...fixture.identity, taskId: 'bench-task', signalId: 'signal-replay', action: 'phase', phase: 'executing' }, 'evt-replay'), turn_id: fixture.identity.turnId };
  let directory = null;
  rows.push(await measure('hook-signal-replay', () => hook(directory, event, { cwd: fixture.project }), {
    prepare: async () => {
      directory = scratch(fixture, 'replay');
      await copyDirectory(fixture.seed, directory);
      // 第一次投递不在计时内；只测同一 event_id 的重复投递。
      await hook(directory, event, { cwd: fixture.project });
    },
  }));
}

// 4. retired-locks 规模：正常自有锁归档成本与目录增长。
for (const count of [0, 2000]) {
  const directory = path.join(area, `retired-${count}`);
  await mutate(directory, async () => {});
  if (count) {
    const retired = path.join(directory, 'retired-locks');
    await fsp.mkdir(retired, { recursive: true });
    for (let index = 0; index < count; index++) await fsp.writeFile(path.join(retired, `${crypto.randomUUID()}.released.lock`), '');
  }
  rows.push(await measure(`lock-retired-${count}`, () => mutate(directory, async () => {})));
}
{
  const directory = path.join(area, 'retired-growth');
  await mutate(directory, async () => {});
  const before = (await fsp.readdir(path.join(directory, 'retired-locks'))).length;
  const operations = 20;
  for (let index = 0; index < operations; index++) await mutate(directory, async () => {});
  const after = (await fsp.readdir(path.join(directory, 'retired-locks'))).length;
  notes.push(`lock-retired-growth: ${operations} 次 mutate 新增 ${after - before} 个归档文件（${((after - before) / operations).toFixed(2)}/次）`);
}

// 5. 预检：相同配置重复执行的开销（4 次真实子进程调用）。
{
  const fake = path.join(area, 'fake-cli.mjs');
  await fsp.writeFile(fake, `const args = process.argv.slice(2);
if (args.includes('--help')) console.log('--json --output-schema --ephemeral --sandbox');
else if (args.includes('features')) console.log('hooks false\\nshell_tool false\\nmulti_agent false\\nplugins false\\nunified_exec true');
else if (args.includes('mcp')) console.log('[]');
else console.log('ok');
`);
  const execute = (executable, args, options = {}) => {
    const run = spawnSync(process.execPath, [fake, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, cwd: options.cwd });
    return Promise.resolve({ code: run.status ?? 1, stdout: run.stdout || '', stderr: run.stderr || '' });
  };
  rows.push(await measure('preflight-codex-fake', () => preflight({ executorPath: fake, profile: null }, path.join(area, 'preflight'), execute)));
  notes.push('preflight-codex-fake: 每次 4 个子进程调用（exec --help、features list、mcp list ×2、features list），未调用真实宿主');
}

// 6. 真实 CLI 子进程：进程内结果与之分开报告。
{
  const fixture = await makeHookFixture('cli', { release, warm: true });
  const outside = path.join(fixture.area, 'outside');
  await fsp.mkdir(outside, { recursive: true });
  const cliMeasure = (label, event) => {
    let directory = null;
    return measure(label, () => {
      const run = spawnSync(process.execPath, [entry, 'hook', '--agent', 'codex', '--state-dir', directory], { encoding: 'utf8', windowsHide: true, timeout: 30000, input: JSON.stringify(event), cwd: outside });
      if (run.status !== 0) throw new Error(`${label} 失败：${run.stderr}`);
      return run.stdout;
    }, {
      prepare: async () => {
        directory = scratch(fixture, label);
        await copyDirectory(fixture.seed, directory);
      },
    });
  };
  rows.push(await cliMeasure('cli-hook-entry-unregistered', { hook_event_name: 'UserPromptSubmit', cwd: outside, session_id: 'other-session', turn_id: 'turn-x', permission_mode: 'default' }));
  const payload = { ...fixture.identity, taskId: 'bench-task', signalId: 'signal-cli', action: 'phase', phase: 'delivering', deliveryId: 'delivery-cli' };
  rows.push(await cliMeasure('cli-hook-signal', { ...signalEvent(payload, 'evt-cli'), cwd: fixture.project, session_id: 'bench-session', turn_id: fixture.identity.turnId, permission_mode: 'default' }));
}

report(rows, notes);
console.log(`临时目录（用 trash 清理）：\n${areas.join('\n')}`);
