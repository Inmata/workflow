#!/usr/bin/env node
// 基线（0.6.3，main 的 ea54419）与 efficiency-review 的实测对比。
// 口径：同一台机器、系统临时目录里的合成状态；进程内测量和真实 CLI 子进程分开；
// 每场景默认 9 次取中位数；I/O 次数用进程内对 node:fs/promises 与 node:crypto 的计数包装得到。
// 所有状态、项目、发布副本、假执行器都在临时目录；CLI 一律显式 --state-dir，不读写真实宿主配置。
// 结束时在 finally 里用 trash 逐个清理临时目录；--json 时 stdout 只有一份合法 JSON。
//
// 用法（父进程）：
//   node scripts/bench/compare.mjs --baseline <基线目录>/bin/workflow.mjs \
//     --current <当前目录>/bin/workflow.mjs [--runs 9] [--rounds 5] [--repeat-order] [--json] \
//     [--out-json docs/plans/efficiency-review-benchmark.json]
// 内部会以 --measure 子进程分别加载两个版本的 src，避免两套模块状态互相影响。
import path from 'node:path';
import os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const here = path.dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const asJSON = process.argv.includes('--json');
const isMeasure = process.argv.includes('--measure');
const runs = Math.max(1, Number(option('runs', '9')) || 9);
const rounds = Math.max(1, Number(option('rounds', '5')) || 5);

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

function begin() { counting = true; counters.calls = {}; counters.bytes = {}; }
function end() { counting = false; return { calls: { ...counters.calls }, bytes: { ...counters.bytes } }; }
const sumCalls = snapshot => Object.values(snapshot.calls).reduce((sum, value) => sum + value, 0);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// —————————————————————————————— 父进程 ——————————————————————————————
function sanitize(value, replacements) {
  if (typeof value === 'string') {
    let text = value;
    for (const [from, to] of replacements) if (from) text = text.split(from).join(to);
    // 兜底：残留的 Windows 绝对路径与用户名不进入产物。
    text = text.replace(/[A-Za-z]:\\[^\s"']+/g, '<path>').replace(/\/tmp\/[^\s"']+/g, '<tmp>');
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, replacements)]));
  return value;
}

function compareRows(baselineRows, currentRows) {
  const currentByKey = new Map(currentRows.map(row => [row.key, row]));
  return baselineRows.map(base => {
    const cur = currentByKey.get(base.key);
    if (!cur) return { key: base.key, label: base.label, kind: base.kind, baseline: base, current: null };
    if (base.kind === 'timing') {
      const delta = {};
      if (Number.isFinite(base.median) && Number.isFinite(cur.median)) delta.medianPercent = Number((((cur.median - base.median) / base.median) * 100).toFixed(1));
      if (Number.isFinite(base.ioCalls) && Number.isFinite(cur.ioCalls)) {
        delta.ioCalls = cur.ioCalls - base.ioCalls;
        delta.ioPercent = base.ioCalls ? Number((((cur.ioCalls - base.ioCalls) / base.ioCalls) * 100).toFixed(1)) : null;
      }
      if (Number.isFinite(base.readBytes) && Number.isFinite(cur.readBytes)) delta.readBytes = cur.readBytes - base.readBytes;
      return { key: base.key, label: base.label, kind: base.kind, note: base.note || cur.note || null, baseline: base, current: cur, delta };
    }
    const delta = {};
    for (const [field, value] of Object.entries(base.values || {})) {
      const next = cur.values?.[field];
      if (Number.isFinite(value) && Number.isFinite(next)) delta[field] = next - value;
    }
    return { key: base.key, label: base.label, kind: base.kind, note: base.note || cur.note || null, baseline: base, current: cur, delta };
  });
}

function printReport(report) {
  console.log(`baseline=${report.versions.baseline.ref} current=${report.versions.current.ref} runs=${report.runs} rounds=${report.rounds}`);
  console.log('— 耗时 / I/O（中位数；CI 为真实 CLI 子进程，含 Node 启动） —');
  for (const row of report.timing) {
    const b = row.baseline, c = row.current;
    if (!c) { console.log(`${row.label.padEnd(34)} 仅基线有数据`); continue; }
    const time = value => value === null || value === undefined ? '    n/a' : `${value.toFixed(2).padStart(9)}ms`;
    const percent = row.delta.medianPercent === undefined ? '    n/a' : `${String(row.delta.medianPercent).padStart(7)}%`;
    const failure = (b.failures || 0) + (c.failures || 0) ? ` 失败 ${b.failures || 0}→${c.failures || 0}` : '';
    console.log(`${row.label.padEnd(34)} ${time(b.median)} → ${time(c.median)}  ${percent}  io ${String(b.ioCalls).padStart(4)}→${String(c.ioCalls).padStart(4)} (${row.delta.ioCalls ?? 'n/a'})${failure}`);
  }
  console.log('— 典型工作流（调用/命令次数） —');
  for (const row of report.workflows) {
    const format = values => Object.entries(values || {}).map(([key, value]) => `${key}=${value}`).join(' ');
    console.log(`${row.label.padEnd(34)} 基线 { ${format(row.baseline.values)} } → 当前 { ${format(row.current?.values)} }`);
  }
  for (const note of report.notes) console.log(`- ${note}`);
}

async function parent() {
  const baseline = option('baseline');
  const current = option('current');
  if (!baseline || !current) {
    process.stderr.write('需要 --baseline <bin/workflow.mjs> 与 --current <bin/workflow.mjs>\n');
    process.exitCode = 2;
    return;
  }
  const baselineEntry = path.resolve(baseline);
  const currentEntry = path.resolve(current);
  const measure = entry => {
    const result = spawnSync(process.execPath, [self, '--measure', '--entry', entry, '--runs', String(runs), '--rounds', String(rounds)], { encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`测量子进程失败（${entry}）：${result.stderr || result.error?.message || result.stdout}`);
    try { return JSON.parse(result.stdout); }
    catch (error) { throw new Error(`测量输出不是合法 JSON（${entry}）：${error.message}\n${result.stdout?.slice(0, 2000)}`); }
  };
  const baselineResult = measure(baselineEntry);
  const currentResult = measure(currentEntry);
  // 顺序复核：同一套场景按 current→baseline 反过来再跑一次，排除“先跑的版本受机器状态影响”的偏差。
  let repeatability = null;
  if (process.argv.includes('--repeat-order')) {
    const currentFirst = measure(currentEntry);
    const baselineSecond = measure(baselineEntry);
    const normalBase = new Map(baselineResult.timing.map(row => [row.key, row]));
    const normalCurrent = new Map(currentResult.timing.map(row => [row.key, row]));
    const swappedBase = new Map(baselineSecond.timing.map(row => [row.key, row]));
    const swappedCurrent = new Map(currentFirst.timing.map(row => [row.key, row]));
    const keys = ['session-start-registered', 'session-start-unregistered', 'user-prompt-registered', 'user-prompt-unregistered', 'posttool-normal', 'stop-registered', 'posttool-signal'];
    repeatability = {
      note: '同一套场景按 baseline→current 与 current→baseline 两种子进程顺序各测 9 次；表中为中位数（ms）。',
      rows: keys.map(key => ({
        key,
        normalOrder: { baseline: normalBase.get(key)?.median ?? null, current: normalCurrent.get(key)?.median ?? null },
        swappedOrder: { baseline: swappedBase.get(key)?.median ?? null, current: swappedCurrent.get(key)?.median ?? null },
      })),
    };
  }
  const replacements = [
    [os.homedir(), '<home>'],
    [os.tmpdir(), '<tmp>'],
    [path.resolve(baselineEntry, '../..'), '<baseline>'],
    [path.resolve(currentEntry, '../..'), '<current>'],
    [os.userInfo().username, '<user>'],
    [os.homedir().replaceAll('\\', '/'), '<home>'],
    [os.tmpdir().replaceAll('\\', '/'), '<tmp>'],
  ];
  const timing = compareRows(baselineResult.timing, currentResult.timing);
  const workflows = compareRows(baselineResult.workflows, currentResult.workflows);
  const report = sanitize({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    machine: { cpu: os.cpus()[0]?.model?.trim() || 'unknown', os: `${os.type()} ${os.release()}`, node: process.version, platform: `${process.platform} ${process.arch}` },
    runs,
    rounds,
    versions: {
      baseline: { ref: option('baseline-ref', 'ea54419'), entry: '<baseline>/bin/workflow.mjs' },
      current: { ref: option('current-ref', '2b1822c'), entry: '<current>/bin/workflow.mjs' },
    },
    timing: timing.map(row => ({
      key: row.key, label: row.label, note: row.note,
      baseline: pickTiming(row.baseline), current: row.current ? pickTiming(row.current) : null, delta: row.delta,
    })),
    workflows: workflows.map(row => ({
      key: row.key, label: row.label, note: row.note,
      baseline: { values: row.baseline.values }, current: row.current ? { values: row.current.values } : null, delta: row.delta,
    })),
    notes: [...new Set([...baselineResult.notes.map(note => `基线：${note}`), ...currentResult.notes.map(note => `当前：${note}`)])],
    ...(repeatability ? { repeatability } : {}),
  }, replacements);

  const outJson = option('out-json');
  if (outJson) await fsp.writeFile(path.resolve(outJson), `${JSON.stringify(report, null, 2)}\n`);
  if (asJSON) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  if (baselineResult.fatal || currentResult.fatal) process.exitCode = 1;
}

function pickTiming(row) {
  return {
    median: row.median, min: row.min, max: row.max, runs: row.runs,
    ioCalls: row.ioCalls, readBytes: row.readBytes, chars: row.chars,
    failures: row.failures, error: row.error || null, calls: row.calls, extra: row.extra || null,
  };
}

// —————————————————————————————— 测量子进程 ——————————————————————————————
const entry = path.resolve(option('entry', path.join(here, '../../bin/workflow.mjs')));
const src = path.resolve(path.dirname(entry), '..', 'src');
const load = name => import(pathToFileURL(path.join(src, name)).href);

const areas = [];
const liveChildren = new Set();
async function setupArea(prefix) {
  const area = await fsp.mkdtemp(path.join(os.tmpdir(), `workflow-compare-${prefix}-`));
  areas.push(area);
  return area;
}

async function copyDirectory(from, to) { await fsp.cp(from, to, { recursive: true }); }
const scratch = (fixture, label) => path.join(fixture.area, `${label}-${crypto.randomUUID()}`);

// 合成发布副本：规模接近当前仓库的 RELEASE_PATHS（约 47 个文件、600+ KB）。
async function makeRelease(area) {
  const { digest } = await load('store.mjs');
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

const knowledgeValue = (index, overrides = {}) => ({
  schemaVersion: 1, id: `knowledge-${String(index).padStart(4, '0')}`, status: 'active', type: 'method',
  importance: index % 17 === 0 ? 'important' : 'normal', maturity: 'verified',
  title: `合成经验 ${index}`, summary: `关于构建与测试的第 ${index} 条合成经验`,
  conditions: `适用条件 ${index}`, scope: { paths: ['src/alpha.mjs'] }, tags: ['bench', `topic-${index % 10}`],
  evidence: [{ kind: 'success', verified: true, incidentId: `incident-${index}`, summary: '合成证据' }],
  createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
});

async function makeKnowledge(project, count, renderEntry) {
  const folder = path.join(project, '.workflow', 'knowledge');
  await fsp.mkdir(folder, { recursive: true });
  for (let index = 0; index < count; index++) await fsp.writeFile(path.join(folder, `knowledge-${String(index).padStart(4, '0')}.md`), renderEntry(knowledgeValue(index)));
  return folder;
}

async function makeAlignmentProject(project) {
  for (let index = 0; index < 300; index++) {
    const file = path.join(project, 'src', `file-${String(index).padStart(3, '0')}.md`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `# 合成资料 ${index}\n${'内容'.repeat(20)}\n`);
  }
}

const signalEvent = (payload, eventId) => ({
  hook_event_name: 'PostToolUse', tool_name: 'Bash',
  tool_input: { command: `node "${entry}" signal --base64 e30=` },
  tool_response: { output: JSON.stringify({ workflow_signal: payload }) },
  event_id: eventId,
});

async function hook(directory, event, options = {}) {
  const { handleHook } = await load('hooks.mjs');
  return handleHook(directory, { cwd: options.cwd || null, session_id: 'bench-session', turn_id: 'turn-1', permission_mode: 'default', ...event }, { synthetic: false, entry });
}

async function makeHookFixture(prefix, { release, knowledge = 0, warm = false, task = false, alignment = false }) {
  const { enableProject } = await load('projects.mjs');
  const { getContext } = await load('context.mjs');
  const { mutate } = await load('store.mjs');
  const { renderEntry } = await load('learning.mjs');
  const area = await setupArea(prefix);
  const project = path.join(area, 'project');
  await fsp.mkdir(project);
  await fsp.writeFile(path.join(project, 'README.md'), '# 项目\n');
  if (knowledge) await makeKnowledge(project, knowledge, renderEntry);
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
  let identity = (await getContext(seed, project, 'lead', sessionId)).identity;
  if (task) {
    const payload = { ...identity, taskId: 'bench-task', signalId: 'signal-seed', action: 'task-start', route: 'lead-direct', goal: '合成基准任务：测量入口与知识检索开销', permissions: { mode: 'write', allowedPaths: ['src/alpha.mjs', 'README.md'] } };
    await hook(seed, signalEvent(payload, 'evt-seed'), { cwd: project });
    identity = (await getContext(seed, project, 'lead', sessionId)).identity;
  }
  if (warm) await hook(seed, { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: sessionId, turn_id: 'turn-2', permission_mode: 'default' });
  identity = (await getContext(seed, project, 'lead', sessionId)).identity;
  return { area, project, seed, identity, sessionId };
}

async function measure(label, operation, { count = runs, prepare, cleanup, note } = {}) {
  const times = [];
  let snapshot = { calls: {}, bytes: {} };
  let chars = 0;
  let failures = 0;
  let error = null;
  let last = null;
  for (let index = 0; index < count; index++) {
    let started = 0;
    let timed = false;
    try {
      if (prepare) await prepare(index);
      begin();
      started = performance.now();
      timed = true;
      const output = await operation(index);
      const finished = performance.now();
      snapshot = end();
      times.push(finished - started);
      chars = output === undefined ? 0 : JSON.stringify(output).length;
      last = output;
    } catch (caught) {
      const finished = performance.now();
      snapshot = end();
      if (timed) times.push(finished - started);
      failures += 1;
      if (!error) error = { code: caught?.code || 'ERROR', message: caught?.message || String(caught) };
      last = null;
    } finally {
      if (cleanup) await cleanup(index);
    }
  }
  return { key: label, label, kind: 'timing', median: median(times), min: times.length ? Math.min(...times) : null, max: times.length ? Math.max(...times) : null, runs: count, times, calls: snapshot.calls, ioCalls: sumCalls(snapshot), readBytes: snapshot.bytes.readFile || 0, chars, failures, error, note, extra: null, last };
}

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
      if (fixture.prepareCopy) await fixture.prepareCopy(directory);
    },
  });
}

// 真实 CLI 子进程的并发/持锁测量。
function runChild(args, { cwd, input } = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 20000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ code, ms: performance.now() - started, out, err });
    });
    child.stdin.end(input || '');
  });
}

const holderSource = `import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [entry, directory, holdMs] = process.argv.slice(2);
const src = path.resolve(path.dirname(entry), '..', 'src');
const { withLock } = await import(pathToFileURL(path.join(src, 'store.mjs')).href);
await withLock(directory, 'state', async () => {
  process.stdout.write('ready\\n');
  await new Promise(resolve => setTimeout(resolve, Number(holdMs)));
});
`;

async function startHolder(area, directory, holdMs) {
  const file = path.join(area, `holder-${crypto.randomUUID()}.mjs`);
  await fsp.writeFile(file, holderSource);
  const child = spawn(process.execPath, [file, entry, directory, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  liveChildren.add(child);
  let ready = false;
  child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) ready = true; });
  for (let index = 0; index < 500 && !ready; index++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!ready) throw new Error('持锁进程未就绪');
  return child;
}

function stopHolder(child) {
  liveChildren.delete(child);
  try { child.kill(); } catch {}
}

// CLI hook 的 stdout 是宿主信封；回执文本在 additionalContext 里，JSON 转义后的引号不能直接正则匹配。
function cliText(out) {
  try {
    const data = JSON.parse(out);
    return data.hookSpecificOutput?.additionalContext || data.systemMessage || out;
  } catch { return String(out || '').replace(/\\"/g, '"'); }
}

async function lockScenario(fixture, label, { holdMs, contenders, signal, area }) {
  const times = [];
  const degraded = [];
  const applied = [];
  let error = null;
  for (let round = 0; round < rounds; round++) {
    let directory = null;
    let holder = null;
    try {
      directory = scratch(fixture, label);
      await copyDirectory(fixture.seed, directory);
      holder = await startHolder(area, directory, holdMs);
      const events = Array.from({ length: contenders }, (_, index) => {
        if (signal) {
          const payload = { ...fixture.identity, taskId: 'bench-task', signalId: `signal-lock-${round}-${index}`, action: 'phase', phase: 'delivering', deliveryId: `delivery-lock-${round}-${index}` };
          return { hook_event_name: 'PostToolUse', cwd: fixture.project, session_id: fixture.sessionId, turn_id: fixture.identity.turnId, permission_mode: 'default', ...signalEvent(payload, `evt-lock-${round}-${index}`) };
        }
        return { hook_event_name: 'UserPromptSubmit', cwd: fixture.project, session_id: fixture.sessionId, turn_id: `turn-lock-${round}-${index}`, permission_mode: 'default' };
      });
      const results = await Promise.all(events.map(event => runChild([entry, 'hook', '--agent', 'codex', '--state-dir', directory], { cwd: fixture.project, input: JSON.stringify(event) })));
      for (const result of results) {
        times.push(result.ms);
        const text = cliText(result.out);
        const bad = /维护暂不可用/.test(text) || /维护暂不可用/.test(result.err);
        degraded.push(bad);
        applied.push(!bad && (signal
          ? /workflow 回执/.test(text) && /"accepted"\s*:\s*true/.test(text)
          : /workflow 入口/.test(text)));
      }
      if (results.some(result => result.code !== 0) && !error) error = { code: 'CLI', message: 'hook 子进程以非零退出码结束' };
    } catch (caught) {
      error = error || { code: caught?.code || 'ERROR', message: caught?.message || String(caught) };
    } finally {
      if (holder) stopHolder(holder);
    }
  }
  const count = value => value.filter(Boolean).length;
  return {
    key: label, label, kind: 'timing',
    median: median(times), min: times.length ? Math.min(...times) : null, max: times.length ? Math.max(...times) : null,
    runs: rounds * contenders, times,
    ioCalls: null, readBytes: null, chars: 0, failures: count(degraded), error,
    note: signal
      ? `每次持锁 ${holdMs}ms；${contenders} 个 signal hook；降级 ${count(degraded)}/${degraded.length}，回执成功 ${count(applied)}/${applied.length}`
      : `每次持锁 ${holdMs}ms；${contenders} 个入口 hook/轮；降级 ${count(degraded)}/${degraded.length}，成功 ${count(applied)}/${applied.length}`,
    extra: {
      degraded: count(degraded), total: degraded.length, applied: count(applied), manualRetries: count(degraded),
      degradedPerRound: Number((count(degraded) / rounds).toFixed(2)), appliedPerRound: Number((count(applied) / rounds).toFixed(2)),
      manualRetriesPerRound: Number((count(degraded) / rounds).toFixed(2)),
    },
  };
}

async function backgroundReview(entryFixture) {
  const { handleHook } = await load('hooks.mjs');
  const { getContext } = await load('context.mjs');
  const { readState } = await load('store.mjs');
  const { capture, readEntries } = await load('learning.mjs');
  const { setLearningEnabled, projectFor } = await load('learning-config.mjs');
  const { tick } = await load('scheduler.mjs');
  const { learningStatus, recoverReview } = await load('review.mjs');
  const area = await setupArea('review');
  const project = path.join(area, 'project');
  const state = path.join(area, 'seed');
  await fsp.mkdir(project);
  await fsp.writeFile(path.join(project, 'README.md'), '# 项目\n');
  const { enableProject } = await load('projects.mjs');
  const projectId = (await enableProject(state, project, { owner: 'bench-session' })).projectId;
  const event = (turn, extra = {}) => handleHook(state, { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: 'bench-session', turn_id: turn, permission_mode: 'default', ...extra }, { synthetic: true, entry });
  const emit = async (payload, eventId) => handleHook(state, { hook_event_name: 'PostToolUse', cwd: project, session_id: 'bench-session', turn_id: payload.turnId, permission_mode: 'default', tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` }, tool_response: { output: JSON.stringify({ workflow_signal: payload }) }, event_id: eventId }, { synthetic: false, entry });
  const startTask = async (taskId, eventId) => {
    const identity = (await getContext(state, project, 'lead', 'bench-session')).identity;
    return emit({ ...identity, taskId, signalId: `signal-start-${taskId}`, action: 'task-start', route: 'lead-direct', goal: '合成后台复盘基准', permissions: { mode: 'write', allowedPaths: ['README.md'] } }, eventId);
  };
  const endTask = async (taskId, eventId) => {
    const identity = (await getContext(state, project, 'lead', 'bench-session')).identity;
    return emit({ ...identity, taskId, signalId: `signal-end-${taskId}`, action: 'task-end', finalRef: 'abc123' }, eventId);
  };
  await event('t1');
  await startTask('bench-task', 'review-e0');
  const identity = (await getContext(state, project, 'lead', 'bench-session')).identity;
  await capture(state, { ...identity, taskId: 'bench-task', observation: { id: 'o1', incidentId: 'incident-1', kind: 'success', summary: '登录超时修复后验证成功', conditions: '登录接口', evidence: ['test:login'], paths: ['src/login.mjs'], verified: true } });
  await endTask('bench-task', 'review-e1');
  await setLearningEnabled(state, project, true);
  const t0 = new Date('2026-10-28T10:00:00Z');
  let calls = 0;
  const answerFor = prompt => {
    const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    return { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, answer: { decisions: data.observations.map(observation => ({ observationIds: [observation.id], action: 'create', targetId: null, supersedes: null, title: '登录超时经验', summary: observation.summary, conditions: observation.conditions, type: 'method', importance: 'normal', status: 'active', paths: ['src/login.mjs'], version: null, tags: ['登录'], reason: '合成验证' })) } };
  };
  const preflight = async () => ({ status: 'capabilities-verified' });
  const first = await tick(state, project, {
    now: t0, nowRequested: true, preflight,
    runner: async (config, prompt) => {
      calls += 1;
      await event('t2');
      await startTask('foreground-task', 'review-e2');
      return answerFor(prompt);
    },
  });
  const pendingAfterFirst = (await learningStatus(state, project)).pending;
  const projectAfterFirst = await projectFor(state, project);
  const learningAfterFirst = { lastCheckedAt: projectAfterFirst.learning?.lastCheckedAt, nextCheckAt: projectAfterFirst.learning?.nextCheckAt, deferCount: projectAfterFirst.learning?.deferCount };
  await endTask('foreground-task', 'review-e3');
  const second = await tick(state, project, {
    now: new Date(t0.getTime() + 30000), nowRequested: true, preflight,
    runner: async () => { calls += 1; throw new Error('延期接续不应调用模型'); },
  });
  const pendingAfterSecond = (await learningStatus(state, project)).pending;
  let manual = null;
  if (pendingAfterSecond) {
    try { manual = await recoverReview(state, project, first.id); }
    catch (caught) { manual = { status: 'error', code: caught?.code || 'ERROR' }; }
  }
  const finalPending = (await learningStatus(state, project)).pending;
  const entries = (await readEntries(await projectFor(state, project))).length;
  return {
    firstStatus: first.status, firstReason: first.reason || null,
    secondStatus: second.status, secondResumed: Boolean(second.resumed),
    modelCalls: calls, ticks: 2,
    manualCommands: manual ? 1 : 0, manualStatus: manual?.status || null,
    pendingAfterFirst, pendingAfterSecond, finalPending, entries,
    lastCheckedAtAfterFirst: learningAfterFirst.lastCheckedAt || null,
    nextCheckAtAfterFirst: learningAfterFirst.nextCheckAt || null,
  };
}

// —— 典型工作流：真实 CLI 子进程 + 当前版本 PostToolUse 回执验证 ——
async function cliFlow(kind) {
  const { enableProject } = await load('projects.mjs');
  const { getContext } = await load('context.mjs');
  const { readState } = await load('store.mjs');
  const { handleHook } = await load('hooks.mjs');
  const area = await setupArea(`flow-${kind}`);
  const project = path.join(area, 'project');
  const state = path.join(area, 'state');
  await fsp.mkdir(project);
  await fsp.writeFile(path.join(project, 'README.md'), '# 项目\n');
  await enableProject(state, project, { owner: 'bench-session' });
  await handleHook(state, { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: 'bench-session', turn_id: 'turn-1', permission_mode: 'default' }, { synthetic: true, entry });
  const identity = (await getContext(state, project, 'lead', 'bench-session')).identity;
  const taskId = 'bench-task';
  const counts = { writes: 0, commands: 0 };
  const token = value => /[\s"]/g.test(value) ? `"${value}"` : value;
  const common = ['--state-dir', state, '--root', project, '--session', identity.sessionId, '--turn', identity.turnId, '--task', taskId];
  const send = async args => {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    counts.commands += 1;
    const command = ['node', token(entry), ...args.map(token)].join(' ');
    const output = await handleHook(state, { hook_event_name: 'PostToolUse', cwd: project, session_id: 'bench-session', turn_id: identity.turnId, permission_mode: 'default', tool_name: 'Bash', tool_input: { command }, tool_response: { output: result.stdout } }, { synthetic: true, entry });
    const text = output.hookSpecificOutput?.additionalContext;
    if (!text?.startsWith('workflow 回执：')) throw new Error(`hook 未回执：${command}；stdout=${result.stdout} stderr=${result.stderr}`);
    const receipt = JSON.parse(text.slice('workflow 回执：'.length));
    if (!receipt.accepted) throw new Error(`信号未被接受：${JSON.stringify(receipt)}`);
    return receipt;
  };
  const payload = async (name, value) => {
    const file = path.join(area, name);
    await fsp.writeFile(file, JSON.stringify(value));
    counts.writes += 1;
    return file;
  };
  const deliveredRef = 'abc123';
  const evidence = ['npm test 263/263 通过', 'npm run check 0 错误'];
  if (kind === 'lead-direct-minimal' || kind === 'lead-direct-validation') {
    await send(['signal', 'task-start', ...common, '--id', 'start-1', '--route', 'lead-direct', '--goal', '合成简单改动', '--mode', 'write', '--paths', 'README.md']);
    if (kind === 'lead-direct-minimal') await send(['signal', 'task-end', ...common, '--id', 'end-1', '--final-ref', deliveredRef]);
    else if (capabilities.inlineValidation) await send(['signal', 'task-end', ...common, '--id', 'end-1', '--final-ref', deliveredRef, ...evidence.flatMap(item => ['--evidence', item])]);
    else {
      const file = await payload('end.json', { validation: { ref: deliveredRef, evidence } });
      await send(['signal', 'task-end', ...common, '--id', 'end-1', '--final-ref', deliveredRef, '--input', file]);
    }
  } else {
    await send(['signal', 'task-start', ...common, '--id', 'start-1', '--route', 'delegated', '--goal', '合成单 Worker + 单 Reviewer', '--mode', 'write', '--paths', 'README.md']);
    if (capabilities.packageFlags) await send(['signal', 'packages', ...common, '--id', 'pkg-1', '--package', 'w1', '--role', 'worker', '--status', 'dispatched', '--channel', 'codeg:claude_code', '--handle', 'worker-task-1']);
    else {
      const file = await payload('dispatch.json', { packages: [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'codeg:claude_code', handle: 'worker-task-1' }] });
      await send(['signal', 'packages', ...common, '--id', 'pkg-1', '--input', file]);
    }
    const batch = await payload('batch.json', { packages: [
      { packageId: 'w1', status: 'consumed', deliveredRef },
      { packageId: 'r1', role: 'reviewer', status: 'dispatched', channel: 'codeg:codex', handle: 'reviewer-task-1', reviews: 'w1' },
    ] });
    await send(['signal', 'packages', ...common, '--id', 'pkg-2', '--input', batch]);
    if (capabilities.packageFlags) await send(['signal', 'packages', ...common, '--id', 'pkg-3', '--package', 'r1', '--status', 'consumed', '--verdict', 'PASS', '--ref', deliveredRef]);
    else {
      const file = await payload('review.json', { packages: [{ packageId: 'r1', status: 'consumed', verdict: 'PASS', reviewedRef: deliveredRef }] });
      await send(['signal', 'packages', ...common, '--id', 'pkg-3', '--input', file]);
    }
    if (capabilities.inlineValidation) await send(['signal', 'task-end', ...common, '--id', 'end-1', '--final-ref', deliveredRef, ...evidence.flatMap(item => ['--evidence', item])]);
    else {
      const file = await payload('end.json', { validation: { ref: deliveredRef, evidence } });
      await send(['signal', 'task-end', ...common, '--id', 'end-1', '--final-ref', deliveredRef, '--input', file]);
    }
  }
  const task = Object.values((await readState(state)).tasks).find(item => item.taskId === taskId);
  const values = { writes: counts.writes, commands: counts.commands, toolCalls: counts.writes + counts.commands, verified: task?.lifecycle === 'complete' };
  if (kind === 'lead-direct-validation' || kind === 'worker-reviewer') values.validation = task?.validation?.evidence?.length || 0;
  return { key: `flow-${kind}`, label: kind === 'lead-direct-minimal' ? '简单改动（lead-direct，最小 task-end）' : kind === 'lead-direct-validation' ? '简单改动（lead-direct，带验证证据）' : '单 Worker + 单 Reviewer（无返修）', kind: 'workflow', values };
}

let capabilities = { inlineValidation: false, packageFlags: false, sources: false, recoverReview: false };
async function detectCapabilities() {
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const text = `${help.stdout || ''}${help.stderr || ''}`;
  capabilities = {
    inlineValidation: text.includes('--validation-ref'),
    packageFlags: text.includes('--package') && text.includes('--verdict'),
    sources: (await fsp.readFile(path.join(src, 'alignment.mjs'), 'utf8')).includes('confirmSources'),
    recoverReview: true,
  };
}

// —— 对齐增量确认：每次全新项目与状态，避免 apply 写出的对齐文档影响下一轮 ——
async function makeIncrementalFixture() {
  const area = await setupArea('align-inc');
  const project = path.join(area, 'project');
  const state = path.join(area, 'seed');
  await fsp.mkdir(path.join(project, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(project, 'README.md'), '# 项目\n原始内容\n');
  await fsp.writeFile(path.join(project, 'docs', 'guide.md'), '# 指南\n内容\n');
  await fsp.writeFile(path.join(project, 'docs', 'design.md'), '# 设计\n内容\n');
  const { enableProject } = await load('projects.mjs');
  const { getContext } = await load('context.mjs');
  const { scanAlignment } = await load('alignment.mjs');
  await enableProject(state, project, { owner: 'bench-session' });
  await hook(state, { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: 'bench-session', turn_id: 'turn-1', permission_mode: 'default' });
  let identity = (await getContext(state, project, 'lead', 'bench-session')).identity;
  const payload = { ...identity, taskId: 'bench-task', signalId: 'signal-align', action: 'task-start', route: 'lead-direct', goal: '合成对齐增量确认', permissions: { mode: 'write', allowedPaths: ['docs/WORKFLOW-ALIGNMENT.md'] } };
  await hook(state, signalEvent(payload, 'evt-align'), { cwd: project });
  identity = (await getContext(state, project, 'lead', 'bench-session')).identity;
  await scanAlignment(state, project);
  return { area, project, state, identity };
}

async function alignmentIncremental() {
  const { readState } = await load('store.mjs');
  const { inspectAlignment, applyAlignment, scanAlignment } = await load('alignment.mjs');
  const extra = { staleAfterApply: 0, repeatPrompts: 0, commands: 0, scanned: 0, confirmed: 0 };
  const row = await measure('alignment-incremental', async () => {
    const fixture = currentFixture;
    await fsp.writeFile(path.join(fixture.project, 'README.md'), '# 项目\n本轮改过的内容\n');
    let project = Object.values((await readState(fixture.state)).projects)[0];
    const first = await inspectAlignment(project);
    const change = (first.changed || []).find(item => item.path === 'README.md');
    const input = { ...fixture.identity, taskId: 'bench-task', docPath: 'docs/WORKFLOW-ALIGNMENT.md', baseline: null, content: '| 项 | 结论 |\n| --- | --- |\n| README | 已确认 |', decisions: [], findings: [] };
    if (capabilities.sources) {
      const info = await fsp.stat(path.join(fixture.project, 'README.md'));
      input.sources = [{ path: 'README.md', size: change?.size ?? info.size, mtimeMs: change?.mtimeMs ?? info.mtimeMs }];
    }
    const applied = await applyAlignment(fixture.state, fixture.project, input);
    if (applied.confirmed) extra.confirmed += applied.confirmed.length;
    project = Object.values((await readState(fixture.state)).projects)[0];
    const second = await inspectAlignment(project);
    let scanned = false;
    if (second.stale) {
      await scanAlignment(fixture.state, fixture.project);
      const projectAfterScan = Object.values((await readState(fixture.state)).projects)[0];
      const third = await inspectAlignment(projectAfterScan);
      if (third.stale) throw new Error('全量 scan 后仍为 stale');
      scanned = true;
    }
    if (second.stale) { extra.staleAfterApply += 1; extra.repeatPrompts += 1; }
    if (scanned) { extra.scanned += 1; extra.commands += 2; } else extra.commands += 1;
    return { applied: applied.status, staleAfterApply: second.stale, scanned };
  }, {
    prepare: async () => { currentFixture = await makeIncrementalFixture(); },
  });
  row.note = `每轮命令数 基线 2 / 当前 1（apply + 全量 scan vs 仅 apply sources）；重复提示 ${extra.repeatPrompts}/${runs}`;
  const per = value => Number((value / runs).toFixed(2));
  row.extra = { staleAfterApply: per(extra.staleAfterApply), repeatPrompts: per(extra.repeatPrompts), commands: per(extra.commands), scanned: per(extra.scanned), confirmed: per(extra.confirmed) };
  return row;
}
let currentFixture = null;

// 入口输出是 `workflow 入口：{json}`；只抽取与知识召回有关的紧致字段，避免把全文写进产物。
function entrySummary(output) {
  const text = output?.hookSpecificOutput?.additionalContext || '';
  if (!text.startsWith('workflow 入口：')) return { entry: false, chars: text.length };
  try {
    const data = JSON.parse(text.slice('workflow 入口：'.length));
    const knowledge = data.knowledge || {};
    return {
      entry: true, chars: text.length,
      knowledgeSelected: Array.isArray(knowledge.selected) ? knowledge.selected.length : null,
      knowledgeSkipped: Number.isFinite(knowledge.skippedTotal) ? knowledge.skippedTotal : null,
      knowledgeCode: knowledge.unavailable?.code || knowledge.error?.code || null,
    };
  } catch { return { entry: true, chars: text.length }; }
}

const summarizeKnowledge = result => result && typeof result === 'object'
  ? { selected: Array.isArray(result.selected) ? result.selected.length : null, skipped: Array.isArray(result.skipped) ? result.skipped.length : (result.skippedTotal ?? null), total: result.total ?? null, chars: result.chars ?? null, excluded: Array.isArray(result.excluded) ? result.excluded.length : (result.excludedTotal ?? null) }
  : null;

// —— 子进程主流程 ——
async function measureMain() {
  const report = { entry, runs, rounds, timing: [], workflows: [], notes: [] };
  try {
    await detectCapabilities();
    const area = await setupArea('main');
    const release = await makeRelease(area);
    const entryFixture = await makeHookFixture('entry', { release, warm: true, task: false });
    const taskFixture = await makeHookFixture('task', { release, warm: true, task: true });
    const outside = path.join(entryFixture.area, 'outside');
    await fsp.mkdir(outside, { recursive: true });

    // 1. hook 入口路径：已接入项目 / 未接入目录。
    const entryEvent = { hook_event_name: 'UserPromptSubmit', session_id: 'bench-session', turn_id: 'turn-3', permission_mode: 'default' };
    const startEvent = { hook_event_name: 'SessionStart', session_id: 'bench-session', turn_id: 'turn-start', permission_mode: 'default', source: 'startup' };
    const stopEvent = { hook_event_name: 'Stop', session_id: 'bench-session', turn_id: entryFixture.identity.turnId, permission_mode: 'default' };
    const normalEvent = { hook_event_name: 'PostToolUse', session_id: 'bench-session', turn_id: 'turn-1', permission_mode: 'default', tool_name: 'Edit', tool_input: { file_path: path.join(entryFixture.project, 'README.md') }, tool_response: {} };
    const outsideEvent = extra => ({ hook_event_name: 'UserPromptSubmit', session_id: 'other-session', turn_id: 'turn-x', permission_mode: 'default', ...extra });
    report.timing.push(await measureHook('session-start-registered', entryFixture, startEvent));
    report.timing.push(await measureHook('session-start-unregistered', entryFixture, outsideEvent({ hook_event_name: 'SessionStart', source: 'startup' }), { cwd: outside }));
    report.timing.push(await measureHook('user-prompt-registered', entryFixture, entryEvent));
    report.timing.push(await measureHook('user-prompt-unregistered', entryFixture, outsideEvent({}), { cwd: outside }));
    report.timing.push(await measureHook('posttool-normal', entryFixture, normalEvent));
    report.timing.push(await measureHook('stop-registered', entryFixture, stopEvent));
    report.timing.push(await measureHook('stop-unregistered', entryFixture, outsideEvent({ hook_event_name: 'Stop' }), { cwd: outside }));
    {
      const payload = { ...taskFixture.identity, taskId: 'bench-task', signalId: 'signal-measured', action: 'phase', phase: 'delivering', deliveryId: 'delivery-1' };
      const event = { ...signalEvent(payload, 'evt-measured'), cwd: taskFixture.project, session_id: taskFixture.sessionId, turn_id: taskFixture.identity.turnId, permission_mode: 'default' };
      report.timing.push(await measureHook('posttool-signal', taskFixture, event));
    }

    // 2. 知识召回：300 条、无变化 / 单条变化 / 坏条目。
    {
      const { selectKnowledge, renderEntry } = await load('learning.mjs');
      const query = { text: '合成经验 构建 测试 src/alpha', paths: ['src/alpha.mjs'] };
      // 任务处于 active 时两个版本才会在入口检索知识；没有任务时基线根本不做这件事，不能这样比。
      const fixture = await makeHookFixture('knowledge-300', { release, knowledge: 300, warm: true, task: true });
      // 预热索引；之后每轮只改状态副本，项目目录共用。
      await selectKnowledge(fixture.seed, fixture.project, query);
      const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'bench-session', turn_id: 'turn-3', permission_mode: 'default' };
      const nochangeHook = await measureHook('hook-entry-nochange-300', fixture, prompt);
      nochangeHook.extra = entrySummary(nochangeHook.last);
      const unchangedSelect = await measureOnCopy('knowledge-select-unchanged-300', fixture, directory => selectKnowledge(directory, fixture.project, query));
      unchangedSelect.extra = summarizeKnowledge(unchangedSelect.last);
      report.timing.push(nochangeHook, unchangedSelect);

      const changedFile = path.join(fixture.project, '.workflow', 'knowledge', 'knowledge-0000.md');
      const original = await fsp.readFile(changedFile, 'utf8');
      await fsp.writeFile(changedFile, renderEntry(knowledgeValue(0, { summary: '变更后的合成经验：更长的正文用于越过索引签名，并仍然保持元数据与正文一致。', conditions: '变更后的适用条件' })));
      try {
        const changedHook = await measureHook('hook-entry-changed-300', fixture, prompt);
        changedHook.extra = entrySummary(changedHook.last);
        const changedSelect = await measureOnCopy('knowledge-select-changed-300', fixture, directory => selectKnowledge(directory, fixture.project, query));
        changedSelect.extra = summarizeKnowledge(changedSelect.last);
        report.timing.push(changedHook, changedSelect);
      } finally {
        await fsp.writeFile(changedFile, original);
      }

      for (const kind of ['badparse', 'badtype']) {
        const bad = await makeHookFixture(`knowledge-${kind}`, { release, knowledge: 300, warm: true, task: true });
        const folder = path.join(bad.project, '.workflow', 'knowledge');
        if (kind === 'badparse') await fsp.writeFile(path.join(folder, 'broken.md'), '# 坏条目\n\n没有元数据\n');
        // 去掉适用范围，确保定向查询只可能命中这一条，便于观察“基线选中 / 当前跳过”。
        else await fsp.writeFile(path.join(folder, 'wrongtype.md'), renderEntry(knowledgeValue(999, { id: 'wrongtype', title: '字段类型错误条目', summary: 'importance 不是字符串', importance: 123, scope: { paths: [] } })));
        // 错字段类型用定向查询：基线会把它当正常条目选中，当前版本应在索引层跳过。
        const badQuery = kind === 'badtype' ? { text: '字段类型错误条目 importance 不是字符串', paths: [] } : query;
        try { await selectKnowledge(bad.seed, bad.project, badQuery); } catch {}
        const selectRow = await measureOnCopy(`knowledge-select-${kind}-300`, bad, directory => selectKnowledge(directory, bad.project, badQuery));
        selectRow.extra = summarizeKnowledge(selectRow.last);
        const hookRow = await measureHook(`hook-entry-${kind}-300`, bad, prompt);
        hookRow.extra = entrySummary(hookRow.last);
        hookRow.note = '直接召回与入口都不应因坏条目阻断；基线在解析失败时整体抛错。';
        report.timing.push(selectRow, hookRow);
      }
    }

    // 3. 对齐：300 项检查与增量确认。
    {
      const { scanAlignment, inspectAlignment } = await load('alignment.mjs');
      const fixture = await makeHookFixture('alignment', { release, alignment: true, warm: true, task: false });
      await scanAlignment(fixture.seed, fixture.project);
      const project = Object.values((await (await load('store.mjs')).readState(fixture.seed)).projects)[0];
      report.timing.push(await measure('alignment-inspect-300', () => inspectAlignment({ ...project, alignment: project.alignment })));
      report.timing.push(await alignmentIncremental());
    }

    // 4. 锁争用：短持锁（HEAD 应等待后成功）与超出预算的长持锁。
    {
      const fixture = await makeHookFixture('lock', { release, warm: true, task: true });
      report.timing.push(await lockScenario(fixture, 'lock-hold400-signal', { holdMs: 400, contenders: 1, signal: true, area: fixture.area }));
      report.timing.push(await lockScenario(fixture, 'lock-hold400-entry3', { holdMs: 400, contenders: 3, signal: false, area: fixture.area }));
      report.timing.push(await lockScenario(fixture, 'lock-hold2600-signal', { holdMs: 2600, contenders: 1, signal: true, area: fixture.area }));
      report.notes.push('锁争用为真实 CLI hook 子进程；持锁进程使用各版本自己的 store.withLock 持有 state 锁。计时含 Node 启动。');
    }

    // 5. 典型工作流。
    report.workflows.push(await cliFlow('lead-direct-minimal'));
    report.workflows.push(await cliFlow('lead-direct-validation'));
    report.workflows.push(await cliFlow('worker-reviewer'));
    {
      const review = await backgroundReview();
      report.workflows.push({
        key: 'flow-background-busy', label: '后台复盘 BUSY 延期后的自动恢复', kind: 'workflow', values: review,
        note: '假执行器计入模型调用；基线第二次 tick 因已推进 lastCheckedAt 返回 interval，需人工 learning recover；当前版本在下一次 30 秒延期机会只重试提交。',
      });
    }
    report.notes.push('I/O 计数只覆盖进程内调用；真实 CLI 子进程按命令/工具调用计数。');
    for (const row of [...report.timing, ...report.workflows]) delete row.last;
  } catch (caught) {
    report.fatal = { code: caught?.code || 'ERROR', message: caught?.message || String(caught), stack: caught?.stack };
  }
  return report;
}

async function measureEntry() {
  let report;
  try { report = await measureMain(); }
  catch (caught) { report = { entry, runs, rounds, timing: [], workflows: [], notes: [], fatal: { code: caught?.code || 'ERROR', message: caught?.message || String(caught), stack: caught?.stack } }; }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

// —— 清理：一律用 trash 移入回收站（不物理删除） ——
async function cleanupAreas() {
  for (const child of [...liveChildren]) {
    try { child.kill(); } catch {}
  }
  liveChildren.clear();
  // 给 holder 的 finally 一点时间释放文件句柄；清理失败不影响测量结果。
  await new Promise(resolve => setTimeout(resolve, 100));
  const failures = [];
  for (const area of areas) {
    const cleaned = spawnSync(`trash "${area}"`, { encoding: 'utf8', windowsHide: true, timeout: 60000, shell: true });
    if (cleaned.status !== 0) failures.push({ area, detail: (cleaned.stderr || cleaned.error?.message || '').trim() });
  }
  if (failures.length) {
    process.stderr.write('临时目录未能用 trash 清理，请手动处理：\n');
    for (const failure of failures) process.stderr.write(`- ${failure.area}${failure.detail ? `\n  ${failure.detail}` : ''}\n`);
  } else if (areas.length) process.stderr.write(`已用 trash 清理 ${areas.length} 个临时目录\n`);
}

if (isMeasure) {
  try { await measureEntry(); }
  finally { await cleanupAreas(); }
} else {
  await parent();
}
