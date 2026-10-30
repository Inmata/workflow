// 合成 fixture（synthetic）：只验证插件的分流、账本与门禁机械行为，不代表真实宿主执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { emptyState, mutate, readState } from '../src/store.mjs';
import { acceptSignal, gateReport, openTurn, stop, taskKey } from '../src/protocol.mjs';
import { codexQuestionFeature, doctor } from '../src/install.mjs';
import { attachWorktree } from '../src/projects.mjs';
import { checkSpecs, precheckSpecs, verifySpecBinding } from '../src/spec.mjs';
import { cli, emit, event, fixture, git, gitFixture, identity, start, temporary } from './helpers.mjs';

const delegated = (f, extra = {}) => emit(f, { action: 'task-start', goal: '分工任务', route: 'delegated', permissions: { mode: 'write', allowedPaths: ['README.md'] }, ...extra });
const packages = (f, items, extra = {}) => emit(f, { action: 'packages', packages: items, ...extra });
const ready = [
  { packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'abc123' },
  { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'abc123', verdict: 'PASS' },
];
// 有 .spec 的 git 项目：search 管辖 src/search.mjs，初始提交后无漂移。
async function specProject() {
  const f = await fixture({ git: true });
  await mkdir(path.join(f.project, '.spec', 'search'), { recursive: true });
  await mkdir(path.join(f.project, 'src'));
  await writeFile(path.join(f.project, '.spec', 'search', 'spec.md'), '---\ntitle: 搜索\ncode:\n  - src/search.mjs\n---\n# 搜索\n');
  await writeFile(path.join(f.project, 'src', 'search.mjs'), 'export const v = 1;\n');
  git(f.project, ['add', '-A']);
  git(f.project, ['commit', '-q', '-m', 'init']);
  return f;
}
async function driftCommit(f, value = 2) {
  await writeFile(path.join(f.project, 'src', 'search.mjs'), `export const v = ${value};\n`);
  git(f.project, ['commit', '-q', '-am', 'change search']);
}

test('报告内存实验（synthetic）：父任务有活动子任务时 task-end 被拒，missing 含子任务', () => {
  const state = emptyState();
  const project = { projectId: 'p1', enabled: true };
  state.projects.p1 = project;
  const lead = openTurn(state, project, 'lead', 't1');
  const child = openTurn(state, project, 'child', 't1');
  const base = s => ({ schemaVersion: 1, projectId: 'p1', sessionId: s.sessionId, turnId: 't1', ticket: s.ticket, interruptEpoch: 0 });
  const permissions = { mode: 'write', allowedPaths: [] };
  acceptSignal(state, { ...base(lead), expectedRevision: lead.revision, taskId: 'parent', signalId: 's1', action: 'task-start', goal: '父', route: 'lead-direct', permissions });
  acceptSignal(state, { ...base(child), expectedRevision: child.revision, taskId: 'sub', signalId: 's2', action: 'task-start', goal: '子', parentTaskId: 'parent', route: 'lead-direct', permissions });
  assert.throws(() => acceptSignal(state, { ...base(lead), expectedRevision: lead.revision, taskId: 'parent', signalId: 's3', action: 'task-end' }), error => error.code === 'GATE' && error.missing.includes('child:sub'));
  assert.equal(state.tasks[taskKey('p1', 'parent')].lifecycle, 'active');
});

test('delegated 缺审查、审查版本不符、缺验证均拒绝且状态不变；豁免后接受', async () => {
  const f = await gitFixture(['merge1']);
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', baseRef: 'base0' }]);
  let ended = await emit(f, { action: 'task-end' });
  assert.equal(ended.result.accepted, false);
  assert.equal(ended.result.reason, 'GATE');
  assert.deepEqual(ended.result.missing, ['terminal:w1', 'review:w1', 'validation']);
  const before = (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  assert.equal(before.lifecycle, 'active');

  await packages(f, [{ packageId: 'w1', status: 'consumed', deliveredRef: 'abc124' }, { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'abc123', verdict: 'PASS' }]);
  ended = await emit(f, { action: 'task-end', finalRef: 'merge1', validation: { ref: 'merge1', evidence: ['npm test: 76 pass'] } });
  assert.deepEqual(ended.result.missing, ['review:w1']);
  // 被拒的 task-end 不能留下部分写入的验证记录。
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].validation, undefined);

  await packages(f, [{ packageId: 'r1', reviewedRef: 'abc124' }], { validation: { ref: 'old', evidence: ['旧版本测试'] } });
  ended = await emit(f, { action: 'task-end', finalRef: 'merge1' });
  assert.deepEqual(ended.result.missing, ['validation']);

  ended = await emit(f, { action: 'task-end', finalRef: 'merge1', waivers: [{ step: 'validation', reason: '用户确认人工验收替代自动回归' }] });
  assert.equal(ended.result.accepted, true);
  assert.equal(ended.result.gate, 'declared-records-consistent');
  const task = (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  assert.equal(task.lifecycle, 'complete');
  assert.deepEqual(task.waivers.map(w => w.step), ['validation']);
});

test('delegated 记录齐全时接受，验证绑定最终版本', async () => {
  const f = await gitFixture(['merge1']);
  await delegated(f);
  await packages(f, ready, { validation: { ref: 'merge1', evidence: ['npm test 通过'] } });
  const ended = await emit(f, { action: 'task-end', finalRef: 'merge1' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('新任务必须显式合法 route；三种合法分流照常建立，漏填或非法值在 task-start 拒绝且不留任务', async () => {
  for (const route of ['lead-direct', 'operation-only', 'delegated']) {
    const f = await fixture();
    const started = await emit(f, { action: 'task-start', goal: '轻量路径', route, permissions: { mode: 'write', allowedPaths: [] } });
    assert.equal(started.result.accepted, true, `${route}: ${JSON.stringify(started.result)}`);
    assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].route, route);
  }
  for (const route of [undefined, null, '', 'auto']) {
    const f = await fixture();
    const started = await emit(f, { action: 'task-start', goal: '轻量路径', permissions: { mode: 'write', allowedPaths: [] }, ...(route === undefined ? {} : { route }) });
    assert.equal(started.result.accepted, false, String(route));
    assert.equal(started.result.reason, 'ROUTE', `${String(route)}: ${started.result.message}`);
    assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)], undefined);
  }
});

test('历史任务（无 route 记录）可识别续接；接续可补声明，声明前结束只给 route-missing', async () => {
  const f = await fixture();
  await emit(f, { action: 'task-start', goal: '历史任务', route: 'operation-only', permissions: { mode: 'write', allowedPaths: [] } });
  const key = taskKey(f.projectId, f.taskId);
  // 模拟旧版本写出的任务记录：字段不存在，而不是新任务漏填。
  await mutate(f.directory, async state => { delete state.tasks[key].route; });
  const continued = await emit(f, { action: 'task-start' });
  assert.equal(continued.result.accepted, true, JSON.stringify(continued.result));
  assert.equal(continued.result.kept.goal, '历史任务');
  const ended = await emit(f, { action: 'task-end' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
  assert.equal(ended.result.warning, 'route-missing');

  // 另一个历史任务可在接续时补声明一次；声明后同历史版本一样不可更改。
  const g = await fixture();
  await emit(g, { action: 'task-start', goal: '历史补声明', route: 'operation-only', permissions: { mode: 'write', allowedPaths: [] } });
  const gKey = taskKey(g.projectId, g.taskId);
  await mutate(g.directory, async state => { delete state.tasks[gKey].route; });
  assert.equal((await emit(g, { action: 'task-start', route: 'lead-direct' })).result.accepted, true);
  assert.equal((await readState(g.directory)).tasks[gKey].route, 'lead-direct');
  assert.equal((await emit(g, { action: 'task-start', route: 'operation-only' })).result.reason, 'ROUTE');

  // 历史任务补声明 delegated 后，结束按 delegated 门禁核对。
  const h = await fixture();
  await emit(h, { action: 'task-start', goal: '历史分工', route: 'operation-only', permissions: { mode: 'write', allowedPaths: [] } });
  const hKey = taskKey(h.projectId, h.taskId);
  await mutate(h.directory, async state => { delete state.tasks[hKey].route; });
  const declared = await emit(h, { action: 'task-start', route: 'delegated' });
  assert.equal(declared.result.accepted, true, JSON.stringify(declared.result));
  assert.equal((await readState(h.directory)).tasks[hKey].route, 'delegated');
  const blocked = await emit(h, { action: 'task-end' });
  assert.equal(blocked.result.accepted, false);
  assert.deepEqual(blocked.result.missing, ['validation']);
});

test('packages 批量 upsert 幂等，返修自增 attempts 并在超过两轮时提示', async () => {
  const f = await fixture();
  await delegated(f);
  const first = await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }], { signalId: 'pkg-stable' });
  const replay = await emit(f, first.payload);
  assert.equal(replay.result.replayed, true);
  let result;
  for (let round = 1; round <= 3; round++) {
    await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: `v${round}` }]);
    result = (await packages(f, [{ packageId: 'w1', status: 'dispatched' }])).result;
    assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].packages.w1.attempts, round);
  }
  assert.equal(result.repairLimit, true);
  assert.deepEqual(result.repairLimitPackages, ['w1']);
  // 输入里的 attempts 不被采信；缺 role 的新包和 worker 带 verdict 均拒绝。
  await packages(f, [{ packageId: 'w1', attempts: 0 }]);
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].packages.w1.attempts, 3);
  assert.equal((await packages(f, [{ packageId: 'w2', status: 'dispatched' }])).result.reason, 'PACKAGE');
  assert.equal((await packages(f, [{ packageId: 'w1', verdict: 'PASS' }])).result.reason, 'PACKAGE');
});

test('返修计数以交付事实为准：启动失败重派不增长，交付后失败/取消再派仍累计', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  // 连续三次“派发后启动失败、从未产出”的重派不计返修。
  for (let round = 0; round < 3; round++) {
    await packages(f, [{ packageId: 'w1', status: 'failed' }]);
    await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
    assert.equal((await taskOf()).packages.w1.attempts, 0, `第 ${round + 1} 次启动失败重派不应计返修`);
  }
  assert.equal((await taskOf()).packages.w1.deliveredAt, undefined);
  // 交付后转 canceled 再派仍算返修，终态不能绕开计数。
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v1' }]);
  assert.ok((await taskOf()).packages.w1.deliveredAt);
  await packages(f, [{ packageId: 'w1', status: 'canceled' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  // 交付后转 failed 再派同样累计，并照常触发两轮提醒。
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v2' }]);
  await packages(f, [{ packageId: 'w1', status: 'failed' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 2);
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v3' }]);
  const result = (await packages(f, [{ packageId: 'w1', status: 'dispatched' }])).result;
  assert.equal(result.repairLimit, true);
  assert.deepEqual(result.repairLimitPackages, ['w1']);
});

test('旧状态无 deliveredAt 仍可读取：按既有交付引用/状态推断返修事实，不猜改历史 attempts', async () => {
  const f = await fixture();
  await delegated(f);
  const stateFile = path.join(f.directory, 'state.json');
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [
    { packageId: 'delivered', role: 'worker', status: 'delivered', deliveredRef: 'v1' },
    { packageId: 'consumed', role: 'worker', status: 'consumed' },
    { packageId: 'failed', role: 'worker', status: 'failed' },
  ]);
  // 模拟旧版本写入的账本：没有新增标记，历史 attempts 原样保留。
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const packagesOfTask = state.tasks[taskKey(f.projectId, f.taskId)].packages;
  for (const item of Object.values(packagesOfTask)) {
    delete item.deliveredAt;
    delete item.deliverySeq;
    delete item.countedRepair;
  }
  packagesOfTask.delivered.attempts = 2;
  await writeFile(stateFile, JSON.stringify(state));
  await packages(f, [
    { packageId: 'delivered', status: 'dispatched' },
    { packageId: 'consumed', status: 'dispatched' },
    { packageId: 'failed', status: 'dispatched' },
  ]);
  const task = await taskOf();
  assert.equal(task.packages.delivered.attempts, 3);
  assert.equal(task.packages.consumed.attempts, 1);
  // 旧记录从未交付：不凭“非 dispatched”猜测历史返修。
  assert.equal(task.packages.failed.attempts, 0);
});

test('已计入的交付/FIX 事实不会被后续启动失败重派重复使用，只有新事实才进入下一轮', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [
    { packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' },
    { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'FIX' },
  ]);
  let result = (await packages(f, [{ packageId: 'w1', status: 'dispatched' }])).result;
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  assert.equal(result.repairLimit, undefined);
  // 这轮返修连续两次启动失败：旧交付与 FIX 已经计过数，重派保持第 1 轮。
  for (let round = 0; round < 2; round++) {
    await packages(f, [{ packageId: 'w1', status: 'failed' }]);
    result = (await packages(f, [{ packageId: 'w1', status: 'dispatched' }])).result;
    assert.equal((await taskOf()).packages.w1.attempts, 1, `第 ${round + 1} 次启动失败重派不应重复计数`);
    assert.equal(result.repairLimit, undefined);
  }
  // 真实再交付并由审查再次 FIX 后重派，才进入第二轮。
  await packages(f, [{ packageId: 'w1', status: 'consumed', deliveredRef: 'v2' }]);
  await packages(f, [{ packageId: 'r1', status: 'consumed', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 2);
  // Reviewer 包重派同样按已计入事实判定：连续启动失败不重复累计。
  await packages(f, [{ packageId: 'rev', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v2', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'rev', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.rev.attempts, 1);
  for (let round = 0; round < 2; round++) {
    await packages(f, [{ packageId: 'rev', status: 'failed' }]);
    await packages(f, [{ packageId: 'rev', status: 'dispatched' }]);
    assert.equal((await taskOf()).packages.rev.attempts, 1, `Reviewer 第 ${round + 1} 次启动失败重派不应重复计数`);
  }
});

test('旧账本只有 delivered/consumed 状态时，转 failed/canceled 仍补记交付事实，重派照常计数', async () => {
  const f = await fixture();
  await delegated(f);
  const stateFile = path.join(f.directory, 'state.json');
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  // 模拟旧版本账本：只在 status 上留下交付事实，没有 deliveredAt/deliverySeq/countedRepair。
  await packages(f, [
    { packageId: 'failedAfter', role: 'worker', status: 'delivered', deliveredRef: 'v1' },
    { packageId: 'canceledAfter', role: 'worker', status: 'consumed' },
  ]);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const packagesOfTask = state.tasks[taskKey(f.projectId, f.taskId)].packages;
  for (const item of Object.values(packagesOfTask)) {
    delete item.deliveredAt;
    delete item.deliverySeq;
    delete item.countedRepair;
  }
  packagesOfTask.failedAfter.attempts = 1;
  await writeFile(stateFile, JSON.stringify(state));
  // 状态先被改写也不会丢掉此前的交付；历史 attempts 不因状态变化本身改动。
  await packages(f, [{ packageId: 'failedAfter', status: 'failed' }, { packageId: 'canceledAfter', status: 'canceled' }]);
  let task = await taskOf();
  assert.equal(task.packages.failedAfter.attempts, 1);
  assert.ok(task.packages.failedAfter.deliveredAt);
  assert.ok(task.packages.canceledAfter.deliveredAt);
  await packages(f, [{ packageId: 'failedAfter', status: 'dispatched' }, { packageId: 'canceledAfter', status: 'dispatched' }]);
  task = await taskOf();
  assert.equal(task.packages.failedAfter.attempts, 2);
  assert.equal(task.packages.canceledAfter.attempts, 1);

  // supersedes 接替旧账本里的交付包时同样先补记事实，再按同一判定累计。
  const g = await fixture();
  await delegated(g);
  const gStateFile = path.join(g.directory, 'state.json');
  await packages(g, [{ packageId: 'old', role: 'worker', status: 'delivered' }]);
  const gState = JSON.parse(await readFile(gStateFile, 'utf8'));
  const oldPackage = gState.tasks[taskKey(g.projectId, g.taskId)].packages.old;
  delete oldPackage.deliveredAt;
  delete oldPackage.deliverySeq;
  delete oldPackage.countedRepair;
  await writeFile(gStateFile, JSON.stringify(gState));
  await packages(g, [{ packageId: 'next', role: 'worker', status: 'dispatched', supersedes: 'old' }]);
  const gTask = (await readState(g.directory)).tasks[taskKey(g.projectId, g.taskId)];
  assert.equal(gTask.packages.next.attempts, 1);
  assert.ok(gTask.packages.old.deliveredAt);
});

test('同一批 packages 里审查 FIX 与重派顺序无关，supersedes 同样适用', async () => {
  for (const fixFirst of [true, false]) {
    const f = await fixture();
    await delegated(f);
    const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
    // 包本身从未交付：唯一返修事实是本批的审查 FIX。
    await packages(f, [{ packageId: 'w1', role: 'worker', status: 'failed' }]);
    const fix = { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', verdict: 'FIX' };
    const redispatch = { packageId: 'w1', status: 'dispatched' };
    await packages(f, fixFirst ? [fix, redispatch] : [redispatch, fix]);
    assert.equal((await taskOf()).packages.w1.attempts, 1, `同包重派 fixFirst=${fixFirst}`);

    const g = await fixture();
    await delegated(g);
    await packages(g, [{ packageId: 'w1', role: 'worker', status: 'failed' }]);
    const supersede = { packageId: 'w2', role: 'worker', status: 'dispatched', supersedes: 'w1' };
    await packages(g, fixFirst ? [fix, supersede] : [supersede, fix]);
    const gTask = (await readState(g.directory)).tasks[taskKey(g.projectId, g.taskId)];
    assert.equal(gTask.packages.w2.attempts, 1, `supersedes fixFirst=${fixFirst}`);
  }
});

test('codeg 路径：交付→FIX→重派后，启动失败以 consumed 收尾不开启新轮次', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v1' }]);
  await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  // 重派后启动失败：Lead 按 codeg 约定用终态结果记 consumed，没有新的 deliveredRef。
  for (let round = 0; round < 2; round++) {
    await packages(f, [{ packageId: 'w1', status: 'consumed' }]);
    await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
    const item = (await taskOf()).packages.w1;
    assert.equal(item.attempts, 1, `第 ${round + 1} 次启动失败记 consumed 后重派不应计返修`);
    assert.equal(item.deliverySeq, 1);
  }
});

test('完整返修轮次：再次交付本身不计数，第二轮交付后重派才累计到 2', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v1' }]);
  await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  // 返修交付并通过审查：交付与 PASS 都不额外计轮，只有下一次重派才计数。
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v2' }]);
  await packages(f, [{ packageId: 'r1', status: 'consumed', reviewedRef: 'v2', verdict: 'PASS' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  // 第二轮完整返修。
  await packages(f, [{ packageId: 'r1', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 2);
});

test('迟到补记同一轮的审查 FIX 或 deliveredRef 不会重复计数', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v1' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  // 重派之后才补记针对 v1 的 FIX：属于已计入的同一轮，之后启动失败再重派仍为 1。
  await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'consumed' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);

  // 先记无引用的交付并重派，之后补记同轮 deliveredRef，同样不多计。
  const g = await fixture();
  await delegated(g);
  const gTaskOf = async () => (await readState(g.directory)).tasks[taskKey(g.projectId, g.taskId)];
  await packages(g, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  await packages(g, [{ packageId: 'w1', status: 'delivered' }]);
  await packages(g, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await gTaskOf()).packages.w1.attempts, 1);
  await packages(g, [{ packageId: 'w1', deliveredRef: 'v1' }]);
  await packages(g, [{ packageId: 'w1', status: 'consumed' }]);
  await packages(g, [{ packageId: 'w1', status: 'dispatched' }]);
  const item = (await gTaskOf()).packages.w1;
  assert.equal(item.attempts, 1);
  assert.equal(item.deliverySeq, 1);
});

test('只记审查 FIX、没有 delivered 记录的隐含交付计一轮，重复重派不重复计', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  await packages(f, [{ packageId: 'w1', status: 'failed' }]);
  await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  await packages(f, [{ packageId: 'w1', status: 'consumed' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
});

test('同一批把审查从 FIX 更正为 PASS 并重派，计数与数组顺序无关，supersedes 同样适用', async () => {
  for (const passFirst of [true, false]) {
    const f = await fixture();
    await delegated(f);
    const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
    await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
    await packages(f, [{ packageId: 'w1', status: 'failed' }]);
    await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', verdict: 'FIX' }]);
    const pass = { packageId: 'r1', verdict: 'PASS', reviewedRef: 'v1' };
    const redispatch = { packageId: 'w1', status: 'dispatched' };
    await packages(f, passFirst ? [pass, redispatch] : [redispatch, pass]);
    assert.equal((await taskOf()).packages.w1.attempts, 0, `同包重派 passFirst=${passFirst}`);

    const g = await fixture();
    await delegated(g);
    const gTaskOf = async () => (await readState(g.directory)).tasks[taskKey(g.projectId, g.taskId)];
    await packages(g, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
    await packages(g, [{ packageId: 'w1', status: 'failed' }]);
    await packages(g, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', verdict: 'FIX' }]);
    const supersede = { packageId: 'w2', role: 'worker', status: 'dispatched', supersedes: 'w1' };
    await packages(g, passFirst ? [pass, supersede] : [supersede, pass]);
    assert.equal((await gTaskOf()).packages.w2.attempts, 0, `supersedes passFirst=${passFirst}`);
  }
});

test('r1 账本的 countedRepair 迁移为轮次标记：已计入的轮次不重复，新交付仍进入下一轮', async () => {
  const f = await fixture();
  await delegated(f);
  const stateFile = path.join(f.directory, 'state.json');
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' }]);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const item = state.tasks[taskKey(f.projectId, f.taskId)].packages.w1;
  // 模拟 r1 写出的状态：只有令牌，没有 countedRound/roundRef。
  item.attempts = 1;
  item.deliverySeq = 1;
  item.countedRepair = ['w1:delivery:1', 'w1:ref:v1'];
  delete item.countedRound;
  delete item.roundRef;
  await writeFile(stateFile, JSON.stringify(state));
  // 已计入的第 1 轮不会因重派再次计数。
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  let current = (await taskOf()).packages.w1;
  assert.equal(current.attempts, 1);
  assert.equal(current.countedRound, 1);
  assert.equal(current.countedRepair, undefined);
  // 新的交付仍开启下一轮。
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v2' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  current = (await taskOf()).packages.w1;
  assert.equal(current.attempts, 2);
  assert.equal(current.deliverySeq, 2);
});

test('从未开启交付轮次时 consumed 不写 deliveredAt，同包重派与 supersedes 都不计返修', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  // 启动失败只留 consumed 状态，没有引用也没有交付轮次：不能回填成第 1 轮。
  for (let round = 0; round < 3; round++) {
    await packages(f, [{ packageId: 'w1', status: 'consumed' }]);
    await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
    const item = (await taskOf()).packages.w1;
    assert.equal(item.attempts, 0, `第 ${round + 1} 次无引用 consumed 后重派不应计返修`);
    assert.equal(item.deliverySeq, 0);
    assert.equal(item.deliveredAt, undefined);
  }
  // 换成 supersedes 接替同样没有已交付的轮次，连续接替也不增加。
  const g = await fixture();
  await delegated(g);
  const gTaskOf = async () => (await readState(g.directory)).tasks[taskKey(g.projectId, g.taskId)];
  await packages(g, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  for (const [index, id] of ['w2', 'w3'].entries()) {
    await packages(g, [{ packageId: index ? 'w2' : 'w1', status: 'consumed' }]);
    await packages(g, [{ packageId: id, role: 'worker', status: 'dispatched', supersedes: index ? 'w2' : 'w1' }]);
    const item = (await gTaskOf()).packages[id];
    assert.equal(item.attempts, 0, `${id} 接替未交付的包不应计返修`);
    assert.equal(item.deliverySeq, 0);
    assert.equal(item.deliveredAt, undefined);
  }
});

test('首轮交付后 consumed、FIX、重派，再交付并 PASS：只有第一次重派计 1', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v1' }]);
  await packages(f, [{ packageId: 'w1', status: 'consumed' }]);
  await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  // 返修后的再交付与 PASS 都不额外计轮，计数停在 1。
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v2' }]);
  await packages(f, [{ packageId: 'r1', status: 'consumed', reviewedRef: 'v2', verdict: 'PASS' }]);
  const item = (await taskOf()).packages.w1;
  assert.equal(item.attempts, 1);
  assert.equal(item.deliverySeq, 2);
});

test('新包直接以 consumed 建账并带新引用，FIX 后重派计 1（验收文档写法）', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'abc123' }]);
  await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'abc123', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  const item = (await taskOf()).packages.w1;
  assert.equal(item.attempts, 1);
  assert.equal(item.deliverySeq, 1);
});

test('第二轮交付未带引用、之后迟到补记新引用：归入同一轮，重派不重复计数', async () => {
  const f = await fixture();
  await delegated(f);
  const taskOf = async () => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  await packages(f, [{ packageId: 'w1', status: 'delivered', deliveredRef: 'v1' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  assert.equal((await taskOf()).packages.w1.attempts, 1);
  // 第二轮交付没带引用；重派后该轮已计入。
  await packages(f, [{ packageId: 'w1', status: 'delivered' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  let item = (await taskOf()).packages.w1;
  assert.equal(item.attempts, 2, '第二轮交付后重派应计 1 次');
  assert.equal(item.deliverySeq, 2);
  assert.equal(item.roundRef, null);
  // 迟到补记的 v2 属于第二轮，不开启第三轮；再次重派保持 2。
  await packages(f, [{ packageId: 'w1', deliveredRef: 'v2' }]);
  await packages(f, [{ packageId: 'w1', status: 'consumed' }]);
  await packages(f, [{ packageId: 'w1', status: 'dispatched' }]);
  item = (await taskOf()).packages.w1;
  assert.equal(item.attempts, 2);
  assert.equal(item.deliverySeq, 2);
  assert.equal(item.roundRef, 'v2');
});

test('压缩后 compact SessionStart 上下文含紧凑账本且不含结果正文', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ ...ready[0], note: '结果正文不应出现在入口上下文中' }, ready[1]]);
  const output = await event(f, 'SessionStart', { source: 'compact' });
  const context = JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 入口：'.length));
  assert.equal(context.ledger.route, 'delegated');
  assert.deepEqual(context.ledger.packages, ['w1 worker consumed abc123 - 0 - -', 'r1 reviewer consumed - PASS@w1:abc123 0 - -']);
  assert.ok(!output.hookSpecificOutput.additionalContext.includes('结果正文不应出现'));
});

test('task show 只读返回账本与门禁缺项', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  const result = cli(['task', 'show', '--task', f.taskId, '--project', f.project, '--state-dir', f.directory]);
  assert.equal(result.status, 0, result.stdout);
  const shown = JSON.parse(result.stdout);
  assert.equal(shown.route, 'delegated');
  assert.equal(shown.packages[0].packageId, 'w1');
  assert.deepEqual(shown.gateMissing, ['terminal:w1', 'review:w1', 'validation']);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
});

test('委派子会话 role-claim 后跨回合保留角色，入口改为对应角色指引', async () => {
  const f = await fixture({ autoOwner: true });
  await start(f);
  const worker = { ...f, sessionId: 'worker-session', turnId: 'worker-turn' };
  await event(worker, 'UserPromptSubmit');
  const claimed = await emit(worker, { action: 'role-claim', role: 'worker', packageId: 'w1' });
  assert.equal(claimed.result.accepted, true, JSON.stringify(claimed.result));
  // 新回合保留角色，入口上下文改为 Worker 指引。
  worker.turnId = 'worker-turn-2';
  const entry = await event(worker, 'UserPromptSubmit');
  assert.ok(entry.hookSpecificOutput.additionalContext.includes('"role":"worker"'));
  // 子会话不能建立业务任务或改角色。
  assert.equal((await emit(worker, { action: 'task-start', goal: 'x', permissions: { mode: 'write', allowedPaths: [] } })).result.reason, 'ROLE');
  assert.equal((await emit(worker, { action: 'role-claim', role: 'reviewer' })).result.reason, 'ROLE');
  // 有活动任务的 Lead 不能声明为子角色。
  assert.equal((await emit(f, { action: 'role-claim', role: 'worker' })).result.reason, 'ROLE');
});

test('宿主子代理事件（带 agent_id）不开 Lead 回合、不改变状态', async () => {
  const f = await fixture({ autoOwner: true });
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  for (const name of ['UserPromptSubmit', 'SessionStart', 'PostToolUse']) {
    assert.deepEqual(await event(f, name, { session_id: 'sub-thread', agent_id: 'agent-1', agent_type: 'worker', tool_name: 'request_user_input' }), {});
  }
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
});

test('计划会话的对齐提示只起草不写入', async () => {
  const f = await fixture();
  f.turnId = 'plan-turn';
  const output = await event(f, 'UserPromptSubmit', { permission_mode: 'plan' });
  assert.ok(output.hookSpecificOutput.additionalContext.includes('当前为计划模式：只扫描、提问和起草，不写文件'));
  f.turnId = 'default-turn';
  assert.ok(!(await event(f, 'UserPromptSubmit')).hookSpecificOutput.additionalContext.includes('当前为计划模式'));
});

test('Codex Plan 协作模式报 permission_mode=default 时，按任务声明的 plan 权限提示', async () => {
  const f = await fixture();
  assert.equal((await emit(f, { action: 'task-start', goal: '计划', route: 'lead-direct', permissions: { mode: 'plan', allowedPaths: [] } })).result.accepted, true);
  const output = await event(f, 'SessionStart', { source: 'compact', permission_mode: 'default' });
  assert.ok(output.hookSpecificOutput.additionalContext.includes('当前为计划模式'));
});

test('doctor --agent codex 只读报告 Default 模式提问开关', async () => {
  const area = await temporary('doctor-');
  const userDir = path.join(area, 'codex');
  await mkdir(userDir);
  assert.equal((await codexQuestionFeature(userDir)).status, 'config-missing');
  const file = path.join(userDir, 'config.toml');
  for (const [text, status] of [
    ['[features]\ndefault_mode_request_user_input = true\n', 'enabled'],
    ['[features]\ndefault_mode_request_user_input = false # 关闭\n', 'disabled'],
    ['model = "x"\n[other]\ndefault_mode_request_user_input = true\n', 'disabled'],
  ]) {
    await writeFile(file, text);
    const report = (await doctor(path.join(area, 'state'), undefined, { agent: 'codex', userDir })).questionInDefaultMode;
    assert.equal(report.status, status);
    assert.equal(!!report.note, status !== 'enabled');
    assert.equal(await readFile(file, 'utf8'), text);
  }
  assert.equal((await doctor(path.join(area, 'state'), undefined, { agent: 'claude' })).questionInDefaultMode, undefined);
});


test('委派状态查询：等待集合含已终态包时提示移出，已结束但未记账时提示记账，状态不写入', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [
    { packageId: 'w1', role: 'worker', status: 'consumed', handle: 'task-a', deliveredRef: 'abc123' },
    { packageId: 'w2', role: 'worker', status: 'dispatched', handle: 'task-b' },
  ]);
  const before = (await readState(f.directory)).revision;
  const response = { content: [{ type: 'text', text: JSON.stringify({ tasks: [{ task_id: 'task-a', status: 'completed', text: '结果正文' }, { task_id: 'task-b', status: 'completed', text: '结果正文' }] }) }] };
  for (const [name, call] of [['mcp__codeg_mcp__get_delegation_status', event], ['mcp__codeg-mcp__get_delegation_status', event]]) {
    const output = await call(f, 'PostToolUse', { tool_name: name, tool_response: response });
    assert.match(output.hookSpecificOutput.additionalContext, /w1.*移出/);
    assert.match(output.hookSpecificOutput.additionalContext, /w2.*已结束/);
    assert.ok(!output.hookSpecificOutput.additionalContext.includes('结果正文'));
  }
  assert.equal((await readState(f.directory)).revision, before);
  const quiet = await event(f, 'PostToolUse', { tool_name: 'mcp__codeg_mcp__get_delegation_status', tool_response: { tasks: [{ task_id: 'task-b', status: 'running' }] } });
  assert.equal(quiet.hookSpecificOutput, undefined);
});

test('有包在途时新用户回合提示中途纠正流程，无在途包时不提示', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  const context = async () => JSON.parse((await event(f, 'SessionStart', { source: 'compact' })).hookSpecificOutput.additionalContext.slice('workflow 入口：'.length));
  assert.match((await context()).instruction, /1 个工作包在途（w1）.*中途纠正/);
  await packages(f, [{ packageId: 'w1', status: 'consumed', deliveredRef: 'abc123' }]);
  assert.doesNotMatch((await context()).instruction, /在途/);
});

test('会话结束挂起的分工任务，新会话入口仍附账本并标出 suspended，不附在途提示', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'deleg-w1' }]);
  await event(f, 'SessionEnd');
  const output = await event(f, 'SessionStart', { source: 'resume', turn_id: 'turn-resume' });
  const context = JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 入口：'.length));
  assert.equal(context.ledger.lifecycle, 'suspended');
  assert.deepEqual(context.ledger.packages, ['w1 worker dispatched - - 0 - -']);
  assert.doesNotMatch(context.instruction, /在途/);
});

test('spec 漂移进入门禁：lead-direct 与历史无 route 都检查，operation-only 不检查；被拒时状态整体回滚', async () => {
  for (const route of ['lead-direct', 'legacy', 'operation-only']) {
    const f = await specProject();
    if (route === 'legacy') {
      await emit(f, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
      const key = taskKey(f.projectId, f.taskId);
      // 旧版本留下的无 route 任务：续接后仍按非 operation-only 检查 spec。
      await mutate(f.directory, async state => { delete state.tasks[key].route; });
    } else {
      await emit(f, { action: 'task-start', goal: '改搜索', route, permissions: { mode: 'write', allowedPaths: [] } });
    }
    await driftCommit(f);
    const ended = await emit(f, { action: 'task-end', validation: { ref: 'HEAD', evidence: ['npm test'] } });
    if (route === 'operation-only') { assert.equal(ended.result.accepted, true, JSON.stringify(ended.result)); continue; }
    assert.equal(ended.result.reason, 'GATE');
    assert.deepEqual(ended.result.missing, ['spec:search']);
    assert.equal(ended.result.findings[0].kind, 'drift');
    assert.match(ended.result.message, /Spec-OK/);
    const task = (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
    assert.equal(task.lifecycle, 'active');
    assert.equal(task.validation, undefined);
  }
});

// 附加 worktree：主树保持主分支，worktree 用自己的分支；两个目录绑定同一 project。
async function worktreeOf(f, name) {
  const tree = path.join(f.area, name);
  git(f.project, ['worktree', 'add', '-q', '-b', name, tree]);
  await attachWorktree(f.directory, f.projectId, tree);
  return { ...f, project: tree };
}

test('task-end 使用当前 worktree：附加 worktree 的漂移会拦住，主树干净也不漏', async () => {
  const f = await specProject();
  const w = await worktreeOf(f, 'wt-drift');
  await emit(w, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  await writeFile(path.join(w.project, 'src', 'search.mjs'), 'export const v = 3;\n');
  git(w.project, ['commit', '-q', '-am', 'change in worktree']);
  assert.equal(git(f.project, ['status', '--porcelain']), '');
  const ended = await emit(w, { action: 'task-end' });
  assert.equal(ended.result.reason, 'GATE', JSON.stringify(ended.result));
  assert.deepEqual(ended.result.missing, ['spec:search']);
  assert.equal(ended.result.findings[0].kind, 'drift');
  assert.equal(ended.result.findings[0].commits.length, 1);
});

test('task-end 在附加 worktree 时不误用主树的未提交改动', async () => {
  const f = await specProject();
  const w = await worktreeOf(f, 'wt-clean');
  await emit(w, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  // 只弄脏主树；worktree 干净时不应因为主树工作区而拦。
  await writeFile(path.join(f.project, 'src', 'search.mjs'), 'export const v = 9;\n');
  const ended = await emit(w, { action: 'task-end' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('计划基线使用当前 worktree：计划只在附加 worktree 时仍提醒回写', async () => {
  const f = await specProject();
  const w = await worktreeOf(f, 'wt-plan');
  await mkdir(path.join(w.project, 'docs'), { recursive: true });
  await writeFile(path.join(w.project, 'docs', 'plan.md'), '# 计划\n- [ ] 第一项\n');
  const started = await emit(w, { action: 'task-start', goal: '按计划实施', route: 'lead-direct', plans: ['docs/plan.md'], permissions: { mode: 'write', allowedPaths: ['docs/plan.md'] } });
  assert.equal(started.result.accepted, true, JSON.stringify(started.result));
  const ended = await emit(w, { action: 'task-end' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
  assert.deepEqual(ended.result.planUnchanged, ['docs/plan.md']);
});
test('F05 Stop 按当前 worktree 的 HEAD 检查 spec：附加 worktree 漂移会挡，主树干净也不漏', async () => {
  const f = await specProject();
  const w = await worktreeOf(f, 'wt-stop-drift');
  await emit(w, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  await writeFile(path.join(w.project, 'src', 'search.mjs'), 'export const v = 4;\n');
  git(w.project, ['commit', '-q', '-am', 'change in worktree']);
  assert.equal(git(f.project, ['status', '--porcelain']), '');
  const blocked = await event(w, 'Stop');
  assert.equal(blocked.decision, 'block', JSON.stringify(blocked));
  assert.match(blocked.reason, /spec:search/);
});

test('spec 缺项不能豁免（类别和完整条目都返回 WAIVER），Spec-OK 空提交放行后结束', async () => {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '重构搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  await driftCommit(f);
  for (const step of ['spec', 'spec:search']) {
    const ended = await emit(f, { action: 'task-end', waivers: [{ step, reason: '纯重构' }] });
    assert.equal(ended.result.reason, 'WAIVER');
  }
  git(f.project, ['commit', '-q', '--allow-empty', '-m', 'spec: search 无需更新', '-m', '重命名内部变量', '--trailer', 'Spec-OK: search']);
  const ended = await emit(f, { action: 'task-end' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('旧任务里记录的 spec 豁免也不抵扣；spec-check 可豁免', async () => {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  await driftCommit(f);
  // 绕过输入校验直接写入状态，模拟历史数据。
  const file = path.join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.tasks[taskKey(f.projectId, f.taskId)].waivers = [{ step: 'spec', reason: '旧数据' }];
  await writeFile(file, JSON.stringify(state));
  assert.deepEqual((await emit(f, { action: 'task-end' })).result.missing, ['spec:search']);

  // 检查不了时（这里用不存在的 finalRef 触发 git 失败）报 spec-check:git，可写理由豁免。
  const g = await specProject();
  await emit(g, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  let ended = await emit(g, { action: 'task-end', finalRef: 'no-such-ref' });
  assert.deepEqual(ended.result.missing, ['spec-check:git']);
  ended = await emit(g, { action: 'task-end', finalRef: 'no-such-ref', waivers: [{ step: 'spec-check', reason: '版本只在远端' }] });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('非 Git 且无 .spec 的接入项目：带 finalRef 收尾不新增 spec-check 缺项', async () => {
  const f = await fixture();
  await emit(f, { action: 'task-start', goal: '接入项目日常改动', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  const ended = await emit(f, { action: 'task-end', finalRef: 'v1' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
  const task = (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  assert.equal(task.lifecycle, 'complete');
  assert.equal(task.finalRef, 'v1');

  // 反向：非 Git 但存在 .spec 时不能当成无 spec，仍报 spec-check:git。
  // Git 仓库内无效 finalRef 的反向用例已由上方“旧任务里记录的 spec 豁免也不抵扣”覆盖。
  const g = await fixture();
  await mkdir(path.join(g.project, '.spec', 'a'), { recursive: true });
  await writeFile(path.join(g.project, '.spec', 'a', 'spec.md'), '---\ncode:\n  - README.md\n---\n');
  await emit(g, { action: 'task-start', goal: '有 spec 的非 Git 项目', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  const blocked = await emit(g, { action: 'task-end', finalRef: 'v1' });
  assert.deepEqual(blocked.result.missing, ['spec-check:git']);
});

// F05：锁外预检的结果只能在 root/ref/任务都匹配时复用；不匹配按 stale 处理，绝不当成“通过”。
async function driftedTask() {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  await driftCommit(f);
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.projectId === f.projectId && item.sessionId === f.sessionId);
  return { f, state, session, task: state.tasks[taskKey(f.projectId, f.taskId)] };
}
test('F05 锁外 spec 预检按 root/ref/任务绑定：不匹配或伪造 payload 都不当作通过', async () => {
  const { f, state, session, task } = await driftedTask();
  const root = f.project;
  const matching = { root, ref: null, projectId: f.projectId, taskId: task.taskId, report: checkSpecs(root, { skipNonGitNoSpec: true }) };
  // 命中绑定的预检报告照常列出真实漂移。
  assert.deepEqual(gateReport(state, task, undefined, root, matching).missing, ['spec:search']);
  // root、ref、任务、项目或不带报告的“跳过”标记都不匹配时，不能用旧报告或一份通过报告放行。
  const passing = { ok: true, ref: 'HEAD', findings: [] };
  const mismatched = [
    { ...matching, root: path.join(f.area, 'other-root'), report: passing },
    { ...matching, ref: 'other-ref', report: passing },
    { ...matching, taskId: 'other-task', report: passing },
    { ...matching, taskId: undefined, report: passing },
    { ...matching, projectId: 'other-project', report: passing },
    { ...matching, projectId: undefined, report: passing },
    { skipped: true },
  ];
  for (const spec of mismatched) assert.deepEqual(gateReport(state, task, undefined, root, spec).missing, ['spec-check:stale'], JSON.stringify(spec));
  // payload 夹带 spec/specReport 不参与门禁；直接调用未传预检结果时走调用内的同步检查。
  const payload = {
    schemaVersion: 1, projectId: f.projectId, sessionId: f.sessionId, turnId: session.turnId, taskId: task.taskId,
    ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision: session.revision,
    signalId: 'signal-forged-spec', action: 'task-end', spec: passing, specReport: passing,
  };
  assert.throws(() => acceptSignal(state, payload, { root }), error => error.code === 'GATE' && error.missing.includes('spec:search'));
});
test('F05 Stop 预检按会话快照绑定：回合、票据或修订变化后不复用旧 spec 结果', async () => {
  const { f, state, session, task } = await driftedTask();
  const project = state.projects[f.projectId];
  const root = f.project;
  const scope = { projectId: f.projectId, sessionId: f.sessionId, turnId: session.turnId, ticket: session.ticket, taskId: task.taskId, revision: session.revision };
  const spec = { root, ref: null, projectId: f.projectId, taskId: task.taskId, report: checkSpecs(root, { skipNonGitNoSpec: true }), scope };
  const matched = stop(state, project, { ...session }, {}, { root, spec });
  assert.equal(matched.decision, 'block');
  assert.match(matched.reason, /spec:search/);
  // 预检后会话回合/票据/修订或 worktree 变化：旧快照不再代表当前 Stop，不能把旧发现当成当前结果。
  const changedSessions = [{ revision: session.revision + 1 }, { turnId: 'turn-other' }, { ticket: 'ticket-other' }];
  for (const change of changedSessions) {
    const stale = stop(state, project, { ...session, ...change, stopBlockedTurn: undefined }, {}, { root, spec });
    assert.equal(stale.decision, 'block', JSON.stringify(change));
    assert.doesNotMatch(stale.reason, /spec:search/, JSON.stringify(change));
    assert.match(stale.reason, /仍为 active/);
  }
  const otherRoot = stop(state, project, { ...session, stopBlockedTurn: undefined }, {}, { root: path.join(f.area, 'other-root'), spec });
  assert.equal(otherRoot.decision, 'block');
  assert.doesNotMatch(otherRoot.reason, /spec:search/);
});

// 预检记录：报告与 binding 一起从锁外生成，scope 绑定当前会话/任务快照。
async function precheckRecord(f, { ref } = {}) {
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.projectId === f.projectId && item.sessionId === f.sessionId);
  const task = state.tasks[taskKey(f.projectId, f.taskId)];
  const precheck = precheckSpecs(f.project, { ref, skipNonGitNoSpec: true });
  const scope = { projectId: f.projectId, sessionId: f.sessionId, turnId: session.turnId, ticket: session.ticket, taskId: task.taskId, revision: session.revision };
  return { state, session, task, spec: { root: f.project, ref: ref ?? null, projectId: f.projectId, taskId: task.taskId, report: precheck.report, binding: precheck.binding, scope } };
}
const gateRejects = (state, payload, spec, missing) => {
  try {
    acceptSignal(structuredClone(state), payload, { root: spec.root, spec });
  } catch (error) {
    assert.equal(error.code, 'GATE', error.message);
    assert.deepEqual(error.missing, missing, error.message);
    return;
  }
  assert.fail('应拒绝过期预检');
};

test('F05 预检绑定实际提交与 HEAD 工作区：干净后改受管代码不再放行，过期不可豁免', async () => {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  const { state, session, spec } = await precheckRecord(f);
  assert.equal(spec.report.ok, true);
  assert.ok(spec.binding, '干净报告必须带检查对象绑定');
  // 干净预检后才改动受管代码：当前工作区会得到 uncommitted-drift，旧报告不能复用。
  await writeFile(path.join(f.project, 'src', 'search.mjs'), 'export const v = 99;\n');
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'end-stale-clean', action: 'task-end' };
  gateRejects(state, payload, spec, ['spec-check:stale']);
  // 类别豁免和历史条目都不能抵扣过期；显式写占用条目直接返回 WAIVER。
  gateRejects(state, { ...payload, signalId: 'end-waived-stale', waivers: [{ step: 'spec-check', reason: '先放行' }] }, spec, ['spec-check:stale']);
  assert.throws(() => acceptSignal(structuredClone(state), { ...payload, signalId: 'end-waiver-entry', waivers: [{ step: 'spec-check:stale', reason: '过期' }] }, { root: f.project, spec }), error => error.code === 'WAIVER');
  // Stop 不能因为过滤 spec-check 就报“已无缺项”，要明确无法确认。
  const project = state.projects[f.projectId];
  const stopped = stop(structuredClone(state), project, { ...session }, {}, { root: f.project, spec });
  assert.equal(stopped.decision, 'block');
  assert.match(stopped.reason, /spec 检查无法确认/);
  assert.match(stopped.reason, /spec-check:stale/);
  assert.doesNotMatch(stopped.reason, /门禁已无缺项/);
  // 会话快照变化同样降级为过期，而不是复用旧报告。
  const changed = stop(structuredClone(state), project, { ...session, revision: session.revision + 1 }, {}, { root: f.project, spec });
  assert.match(changed.reason, /spec 检查无法确认/);
  // 按当前工作区重新预检：真实漂移仍然照常列出（不是 stale），恢复后再预检才放行。
  const dirty = await precheckRecord(f);
  assert.deepEqual(dirty.spec.report.findings.map(item => item.kind), ['uncommitted-drift']);
  gateRejects(dirty.state, { ...payload, signalId: 'end-fresh-dirty' }, dirty.spec, ['spec:search']);
  await writeFile(path.join(f.project, 'src', 'search.mjs'), 'export const v = 1;\n');
  const fresh = await precheckRecord(f);
  assert.equal(acceptSignal(structuredClone(fresh.state), { ...payload, signalId: 'end-fresh-clean' }, { root: f.project, spec: fresh.spec }).accepted, true);
});

test('F05 预检绑定目标提交：HEAD 移动或分支 ref 移动后旧报告作废，固定 OID 仍有效', async () => {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  const head = await precheckRecord(f);
  const branch = await precheckRecord(f, { ref: 'main' });
  const oid = git(f.project, ['rev-parse', 'HEAD']);
  const pinned = await precheckRecord(f, { ref: oid });
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'end-head-moved', action: 'task-end' };
  // 空提交也会移动 HEAD：旧报告检查的不是当前提交。
  git(f.project, ['commit', '-q', '--allow-empty', '-m', 'noop']);
  gateRejects(head.state, { ...payload, signalId: 'end-head-moved-head' }, head.spec, ['spec-check:stale']);
  // 分支 ref 指向新提交后，按标签复用同样过期。
  gateRejects(branch.state, { ...payload, finalRef: 'main', signalId: 'end-head-moved-branch' }, branch.spec, ['spec-check:stale']);
  // 完整 OID 不可移动，检查对象仍是同一提交，可以复用。
  const accepted = acceptSignal(structuredClone(pinned.state), { ...payload, finalRef: oid, signalId: 'end-pinned-oid' }, { root: f.project, spec: pinned.spec });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
});

test('F05 task-end 预检绑定会话与任务快照：回合、票据、任务或修订变化后不复用', async () => {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  const { state, session, spec } = await precheckRecord(f);
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'end-scope', action: 'task-end' };
  const changes = [
    { sessionId: 'session-other' }, { turnId: 'turn-other' }, { ticket: 'ticket-other' },
    { taskId: 'task-other' }, { revision: session.revision + 1 }, { projectId: 'project-other' },
  ];
  for (const scope of changes) {
    gateRejects(state, { ...payload, signalId: `end-scope-${Object.keys(scope)[0]}` }, { ...spec, scope: { ...spec.scope, ...scope } }, ['spec-check:stale']);
  }
  // 没有 scope 的预检（旧调用方）同样不能当作当前结果。
  gateRejects(state, { ...payload, signalId: 'end-scope-missing' }, { ...spec, scope: undefined }, ['spec-check:stale']);
  // 快照一致时照常放行。
  assert.equal(acceptSignal(structuredClone(state), { ...payload, signalId: 'end-scope-fresh' }, { root: f.project, spec }).accepted, true);
});

test('F05 binding 复核本身：提交、受管文件、spec 清单与索引变化都判过期', async () => {
  const f = await specProject();
  const precheck = precheckSpecs(f.project, { skipNonGitNoSpec: true });
  assert.equal(precheck.report.ok, true);
  assert.equal(verifySpecBinding(f.project, precheck.binding, null), true);
  // 受管代码改动。
  await writeFile(path.join(f.project, 'src', 'search.mjs'), 'export const v = 5;\n');
  assert.equal(verifySpecBinding(f.project, precheck.binding, null), false);
  await writeFile(path.join(f.project, 'src', 'search.mjs'), 'export const v = 1;\n');
  assert.equal(verifySpecBinding(f.project, precheck.binding, null), true);
  // spec 正文改动（code 清单不变也会影响是否抑制 uncommitted-drift）。
  await writeFile(path.join(f.project, '.spec', 'search', 'spec.md'), '---\ntitle: 搜索\ncode:\n  - src/search.mjs\n---\n# 搜索 v2\n');
  assert.equal(verifySpecBinding(f.project, precheck.binding, null), false);
  await writeFile(path.join(f.project, '.spec', 'search', 'spec.md'), '---\ntitle: 搜索\ncode:\n  - src/search.mjs\n---\n# 搜索\n');
  assert.equal(verifySpecBinding(f.project, precheck.binding, null), true);
  // 暂存改动（工作区内容不变）由索引快照发现；索引被改写后即使恢复内容也不再复用旧绑定。
  await writeFile(path.join(f.project, 'README.md'), '# 项目\n暂存改动\n');
  git(f.project, ['add', 'README.md']);
  assert.equal(verifySpecBinding(f.project, precheck.binding, null), false);
  git(f.project, ['reset', '-q', 'HEAD', 'README.md']);
  await writeFile(path.join(f.project, 'README.md'), '# 项目\n原始内容\n');
  assert.equal(verifySpecBinding(f.project, precheck.binding, null), false);
  // HEAD 移动与可移动 ref：按新状态重新预检后再改动。
  const fresh = precheckSpecs(f.project, { skipNonGitNoSpec: true });
  assert.equal(verifySpecBinding(f.project, fresh.binding, null), true);
  const head = git(f.project, ['rev-parse', 'HEAD']);
  const byBranch = precheckSpecs(f.project, { ref: 'main', skipNonGitNoSpec: true });
  assert.equal(verifySpecBinding(f.project, byBranch.binding, 'main'), true);
  git(f.project, ['commit', '-q', '--allow-empty', '-m', 'noop']);
  assert.equal(verifySpecBinding(f.project, fresh.binding, null), false);
  assert.equal(verifySpecBinding(f.project, byBranch.binding, 'main'), false);
  assert.equal(verifySpecBinding(f.project, byBranch.binding, head), false, '标签复核必须使用同一标签');
});

// F05 定向反例：status 返回后另一个会话把 spec 暂存回干净，索引随即变化。
// 报告是拿旧索引的 dirty 结果算出的；不能配上新索引放行，只能按不可豁免的 stale 拒绝。
test('F05 预检 status 后索引被改写：通过报告不复用，门禁按不可豁免 stale 拒绝', async () => {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '索引竞态', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  const specPath = '.spec/search/spec.md';
  const original = '---\ntitle: 搜索\ncode:\n  - src/search.mjs\n---\n# 搜索\n';
  await writeFile(path.join(f.project, 'src', 'search.mjs'), 'export const v = 99;\n');
  await writeFile(path.join(f.project, specPath), `${original}staged edit\n`);
  git(f.project, ['add', specPath]);
  await writeFile(path.join(f.project, specPath), original);
  const real = child.spawnSync;
  let staged = false;
  child.spawnSync = (command, args = [], options) => {
    const result = real(command, args, options);
    if (!staged && command === 'git' && Array.isArray(args) && args.includes('status')) {
      staged = true;
      git(f.project, ['add', specPath]);
    }
    return result;
  };
  let record;
  try {
    syncBuiltinESMExports();
    record = await precheckRecord(f);
  } finally {
    child.spawnSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(staged, true, '竞争样本应在 status 之后改写索引');
  assert.equal(record.spec.report.ok, true, '旧报告按 status 看到的 dirty 结果放行');
  assert.equal(verifySpecBinding(f.project, record.spec.binding, null), false, '索引已变，旧报告不能复核通过');
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'end-index-race', action: 'task-end' };
  gateRejects(record.state, payload, record.spec, ['spec-check:stale']);
  gateRejects(record.state, { ...payload, signalId: 'end-index-race-waived', waivers: [{ step: 'spec-check', reason: '先放行' }] }, record.spec, ['spec-check:stale']);
  assert.deepEqual(checkSpecs(f.project, { skipNonGitNoSpec: true }).findings.map(item => item.kind), ['uncommitted-drift'], '当前工作区实际是未提交漂移');
});


test('delegated 门禁同时列出 spec 缺项；task show 显示 spec 发现与变更条数', async () => {
  const f = await specProject();
  await delegated(f);
  await driftCommit(f);
  const change = { summary: '搜索结果改为分页', reason: '用户追加要求', packages: ['w1'] };
  assert.equal((await packages(f, ready, { change, validation: { ref: 'HEAD', evidence: ['npm test'] } })).result.accepted, true);
  assert.equal((await packages(f, [{ packageId: 'w1', note: '已同步' }], { change: { summary: '只改文案', reason: '细节' } })).result.accepted, true);
  assert.equal((await packages(f, [{ packageId: 'w1' }], { change: { summary: '' } })).result.reason, 'INPUT');
  const ended = await emit(f, { action: 'task-end' });
  assert.deepEqual(ended.result.missing, ['spec:search']);
  const shown = JSON.parse(cli(['task', 'show', '--task', f.taskId, '--project', f.project, '--state-dir', f.directory]).stdout);
  assert.deepEqual(shown.gateMissing, ['spec:search']);
  assert.equal(shown.specFindings[0].code, 'src/search.mjs');
  assert.equal(shown.changes, 2);
  const task = (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
  assert.deepEqual(task.changes.map(c => c.summary), ['搜索结果改为分页', '只改文案']);
  const output = await event(f, 'SessionStart', { source: 'compact' });
  assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 入口：'.length)).ledger.changes, 2);
});

test('回合结束核对：有缺项挡一次并列出缺项，不改任务状态；同回合与 stop_hook_active 放行', async () => {
  const f = await specProject();
  await emit(f, { action: 'task-start', goal: '改搜索', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  await driftCommit(f);
  const key = taskKey(f.projectId, f.taskId);
  const before = (await readState(f.directory)).tasks[key];
  assert.deepEqual(await event(f, 'Stop', { stop_hook_active: true }), {});
  const blocked = await event(f, 'Stop');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /spec:search/);
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.deepEqual((await readState(f.directory)).tasks[key], before);
  // 新用户回合重新核对一次。
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  assert.equal((await event(f, 'Stop')).decision, 'block');
});

test('回合结束核对：在途包挡一次要求继续等待；waiting-user、operation-only 路线、子角色会话、已结束任务都放行；已记豁免照常抵扣', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'task-abc' }]);
  const waiting = await event(f, 'Stop');
  assert.equal(waiting.decision, 'block');
  assert.match(waiting.reason, /1 个工作包在途（w1\(task-abc\)）.*wait_ms: 0.*说明为什么暂停/);
  assert.deepEqual(await event(f, 'Stop'), {});
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  await packages(f, [{ packageId: 'w1', status: 'consumed', deliveredRef: 'abc' }]);
  const blocked = await event(f, 'Stop');
  assert.match(blocked.reason, /review:w1, validation/);

  const g = await fixture();
  await start(g);
  await event(g, 'PostToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] }, tool_response: {} });
  assert.deepEqual(await event(g, 'Stop'), {});

  const h = await fixture();
  await emit(h, { action: 'task-start', goal: '查看', route: 'operation-only', permissions: { mode: 'read-only', allowedPaths: [] } });
  assert.deepEqual(await event(h, 'Stop'), {});
  assert.equal((await emit(h, { action: 'task-end' })).result.accepted, true);
  h.turnId = 'turn-2';
  await event(h, 'UserPromptSubmit');
  assert.deepEqual(await event(h, 'Stop'), {});

  const w = await fixture({ autoOwner: true });
  const worker = { ...w, sessionId: 'worker-session', turnId: 'worker-turn' };
  await event(worker, 'UserPromptSubmit');
  await emit(worker, { action: 'role-claim', role: 'worker', packageId: 'w1' });
  assert.deepEqual(await event(worker, 'Stop'), {});

  // validation 已在早先 task-end 中豁免并记入任务（这里由完整记录提供），Stop 不再列出。
  const v = await fixture();
  await delegated(v);
  await packages(v, ready);
  const reason = (await event(v, 'Stop')).reason;
  assert.match(reason, /validation/);
  const file = path.join(v.directory, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.tasks[taskKey(v.projectId, v.taskId)].waivers = [{ step: 'validation', reason: '用户人工验收' }];
  await writeFile(file, JSON.stringify(state));
  v.turnId = 'turn-2';
  await event(v, 'UserPromptSubmit');
  assert.match((await event(v, 'Stop')).reason, /已无缺项/);
});

test('task-start 字段错误时回执点名缺项与放错位置的字段', async () => {
  const f = await fixture();
  const noGoal = await emit(f, { action: 'task-start', route: 'delegated', permissions: { mode: 'write', allowedPaths: [] } });
  assert.equal(noGoal.result.reason, 'INPUT');
  assert.match(noGoal.result.message, /缺少 goal.*permissions:\{mode/);
  const misplaced = await emit(f, { action: 'task-start', goal: '改搜索', route: 'delegated', mode: 'write', allowedPaths: [] });
  assert.equal(misplaced.result.reason, 'PERMISSION');
  assert.match(misplaced.result.message, /缺少 permissions 对象.*mode、allowedPaths 写在了顶层/);
  const badMode = await emit(f, { action: 'task-start', goal: '改搜索', route: 'delegated', permissions: { mode: 'edit', allowedPaths: [] } });
  assert.match(badMode.result.message, /permissions\.mode 须为 write、read-only 或 plan/);
  assert.equal((await emit(f, { action: 'task-start', goal: '改搜索', route: 'delegated', permissions: { mode: 'write', allowedPaths: [] } })).result.accepted, true);
});

test('关联计划软提醒：计划未改时 Stop 与 task-end 回执提醒回写，不进缺项也不挡 task-end；改过或已移走不提醒', async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, 'docs'));
  await writeFile(path.join(f.project, 'docs', 'plan.md'), '# 计划\n- [ ] 第一项\n');
  const started = await emit(f, { action: 'task-start', goal: '按计划实施', route: 'lead-direct', plans: ['docs/plan.md'], permissions: { mode: 'write', allowedPaths: ['docs/plan.md'] } });
  assert.equal(started.result.accepted, true, JSON.stringify(started.result));
  const shown = JSON.parse(cli(['task', 'show', '--task', f.taskId, '--project', f.project, '--state-dir', f.directory]).stdout);
  assert.deepEqual(shown.planUnchanged, ['docs/plan.md']);
  assert.deepEqual(shown.gateMissing, []);
  const blocked = await event(f, 'Stop');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /已无缺项.*关联计划 docs\/plan\.md 自任务开始后没有改动/);
  // 计划不能改声明，可原样重复。
  assert.equal((await emit(f, { action: 'task-start', plans: ['docs/other.md'] })).result.reason, 'PLAN');
  const ended = await emit(f, { action: 'task-end' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
  assert.deepEqual(ended.result.planUnchanged, ['docs/plan.md']);
  assert.match(ended.result.reminder, /回写/);

  const g = await fixture();
  await mkdir(path.join(g.project, 'docs'));
  await writeFile(path.join(g.project, 'docs', 'plan.md'), '# 计划\n');
  await writeFile(path.join(g.project, 'docs', 'done.md'), '# 旧计划\n');
  await emit(g, { action: 'task-start', goal: 'x', route: 'lead-direct', plans: ['docs/plan.md', 'docs/done.md'], permissions: { mode: 'write', allowedPaths: [] } });
  await writeFile(path.join(g.project, 'docs', 'plan.md'), '# 计划\n- [x] 第一项（abc123）\n');
  await rm(path.join(g.project, 'docs', 'done.md'));
  assert.doesNotMatch((await event(g, 'Stop')).reason, /关联计划/);
  const done = await emit(g, { action: 'task-end' });
  assert.equal(done.result.planUnchanged, undefined);

  const h = await fixture();
  for (const plans of [['../outside.md'], ['C:/x.md'], [], 'docs/plan.md']) {
    assert.equal((await emit(h, { action: 'task-start', goal: 'x', route: 'lead-direct', plans, permissions: { mode: 'write', allowedPaths: [] } })).result.reason, 'PLAN');
  }
});
