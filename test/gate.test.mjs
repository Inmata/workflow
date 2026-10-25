// 合成 fixture（synthetic）：只验证插件的分流、账本与门禁机械行为，不代表真实宿主执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { emptyState, readState } from '../src/store.mjs';
import { acceptSignal, openTurn, taskKey } from '../src/protocol.mjs';
import { codexQuestionFeature, doctor } from '../src/install.mjs';
import { cli, emit, event, fixture, git, start, temporary } from './helpers.mjs';

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
  acceptSignal(state, { ...base(lead), expectedRevision: lead.revision, taskId: 'parent', signalId: 's1', action: 'task-start', goal: '父', permissions });
  acceptSignal(state, { ...base(child), expectedRevision: child.revision, taskId: 'sub', signalId: 's2', action: 'task-start', goal: '子', parentTaskId: 'parent', permissions });
  assert.throws(() => acceptSignal(state, { ...base(lead), expectedRevision: lead.revision, taskId: 'parent', signalId: 's3', action: 'task-end' }), error => error.code === 'GATE' && error.missing.includes('child:sub'));
  assert.equal(state.tasks[taskKey('p1', 'parent')].lifecycle, 'active');
});

test('delegated 缺审查、审查版本不符、缺验证均拒绝且状态不变；豁免后接受', async () => {
  const f = await fixture();
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
  const f = await fixture();
  await delegated(f);
  await packages(f, ready, { validation: { ref: 'merge1', evidence: ['npm test 通过'] } });
  const ended = await emit(f, { action: 'task-end', finalRef: 'merge1' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('lead-direct、operation-only 与无 route 旧任务照常结束；未声明 route 带 warning', async () => {
  for (const route of ['lead-direct', 'operation-only', undefined]) {
    const f = await fixture();
    await emit(f, { action: 'task-start', goal: '轻量路径', permissions: { mode: 'write', allowedPaths: [] }, ...(route ? { route } : {}) });
    const ended = await emit(f, { action: 'task-end' });
    assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
    assert.equal(ended.result.warning, route ? undefined : 'route-missing');
  }
  const f = await fixture();
  assert.equal((await emit(f, { action: 'task-start', goal: 'x', route: 'auto', permissions: { mode: 'write', allowedPaths: [] } })).result.reason, 'ROUTE');
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

test('压缩后 compact SessionStart 上下文含紧凑账本且不含结果正文', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ ...ready[0], note: '结果正文不应出现在入口上下文中' }, ready[1]]);
  const output = await event(f, 'SessionStart', { source: 'compact' });
  const context = JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 入口：'.length));
  assert.equal(context.ledger.route, 'delegated');
  assert.deepEqual(context.ledger.packages, ['w1 worker consumed abc123 - 0', 'r1 reviewer consumed - PASS@w1:abc123 0']);
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
  assert.equal((await emit(f, { action: 'task-start', goal: '计划', permissions: { mode: 'plan', allowedPaths: [] } })).result.accepted, true);
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
  assert.deepEqual(context.ledger.packages, ['w1 worker dispatched - - 0']);
  assert.doesNotMatch(context.instruction, /在途/);
});

test('spec 漂移进入门禁：lead-direct 与无 route 都检查，operation-only 不检查；被拒时状态整体回滚', async () => {
  for (const route of ['lead-direct', undefined, 'operation-only']) {
    const f = await specProject();
    await emit(f, { action: 'task-start', goal: '改搜索', permissions: { mode: 'write', allowedPaths: [] }, ...(route ? { route } : {}) });
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

test('回合结束核对：在途包、waiting-user、operation-only 路线、子角色会话、已结束任务都放行；已记豁免照常抵扣', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  assert.deepEqual(await event(f, 'Stop'), {});
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
