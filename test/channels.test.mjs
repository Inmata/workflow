// 合成 fixture（synthetic）：0.6.2 派工通道、supersedes 返修链、已审包豁免限制、分通道 Stop 提示与内置子代理信号回执。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readState } from '../src/store.mjs';
import { taskKey } from '../src/protocol.mjs';
import { cli, emit, entry, event, fixture } from './helpers.mjs';

const delegated = (f, extra = {}) => emit(f, { action: 'task-start', goal: '分工任务', route: 'delegated', permissions: { mode: 'write', allowedPaths: ['README.md'] }, ...extra });
const packages = (f, items, extra = {}) => emit(f, { action: 'packages', packages: items, ...extra });
const taskOf = async f => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
const validation = { ref: 'm1', evidence: ['npm test'] };

test('channels：与声明不一致的包未附 change 时拒绝，附 change 后接受，已记过的偏离不再重复要求', async () => {
  const f = await fixture();
  const channels = { worker: 'codeg:claude_code', reviewer: 'codeg:codex' };
  await delegated(f, { channels });
  assert.equal((await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'task-1', channel: 'codeg:claude_code' }])).result.accepted, true);
  const silent = await packages(f, [{ packageId: 'w2', role: 'worker', status: 'dispatched', channel: 'builtin:general-purpose' }]);
  assert.equal(silent.result.reason, 'CHANNEL');
  assert.match(silent.result.message, /builtin:general-purpose 与任务声明的 worker=codeg:claude_code 不一致.*change/);
  // 漏填 channel 也算不一致。
  assert.equal((await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'dispatched', handle: 'task-2' }])).result.reason, 'CHANNEL');
  // change 没列出该包仍拒绝。
  const other = { summary: '换通道', reason: '用户同意', packages: ['w9'] };
  assert.equal((await packages(f, [{ packageId: 'w2', role: 'worker', status: 'dispatched', channel: 'builtin:general-purpose' }], { change: other })).result.reason, 'CHANNEL');
  const change = { summary: 'w2 改用内置子代理', reason: '用户同意：Codeg 额度用尽', packages: ['w2'] };
  assert.equal((await packages(f, [{ packageId: 'w2', role: 'worker', status: 'dispatched', channel: 'builtin:general-purpose' }], { change })).result.accepted, true);
  assert.equal((await packages(f, [{ packageId: 'w2', status: 'delivered', deliveredRef: 'v1' }])).result.accepted, true);
  assert.equal((await packages(f, [{ packageId: 'w2', status: 'dispatched' }])).result.accepted, true);
  // 已合规的包改到偏离通道是新偏离，仍要 change。
  assert.equal((await packages(f, [{ packageId: 'w1', channel: 'lead' }])).result.reason, 'CHANNEL');
  const task = await taskOf(f);
  assert.equal(task.changes.length, 1);
  assert.deepEqual(task.channels, channels);
  // 通道只能首次或补声明；相同声明照常接受。
  assert.equal((await emit(f, { action: 'task-start', channels: { worker: 'lead' } })).result.reason, 'CHANNEL');
  assert.equal((await emit(f, { action: 'task-start', channels })).result.accepted, true);
  const shown = JSON.parse(cli(['task', 'show', '--task', f.taskId, '--project', f.project, '--state-dir', f.directory]).stdout);
  assert.deepEqual(shown.channels, channels);
});

test('channels：分工任务的 worker 包由 Lead 实施须附 change；未声明通道或 lead-direct 任务行为不变；输入校验', async () => {
  const f = await fixture();
  await delegated(f);
  assert.equal((await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'lead-direct' }])).result.reason, 'CHANNEL');
  assert.equal((await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'lead' }])).result.reason, 'CHANNEL');
  assert.equal((await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'lead' }], { change: { summary: 'Lead 实施 w1', reason: '单行修复，用户同意', packages: ['w1'] } })).result.accepted, true);
  // Lead 自审 reviewer 包不在此规则内；未填通道的包与 0.6.1 相同。
  assert.equal((await packages(f, [{ packageId: 'r1', role: 'reviewer', status: 'dispatched', channel: 'lead' }, { packageId: 'w9', role: 'worker', status: 'dispatched' }])).result.accepted, true);
  assert.equal((await taskOf(f)).channels, undefined);

  const g = await fixture();
  await emit(g, { action: 'task-start', goal: 'x', route: 'lead-direct', permissions: { mode: 'write', allowedPaths: [] } });
  assert.equal((await packages(g, [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'lead' }])).result.accepted, true);

  for (const channels of [{}, { lead: 'x' }, ['codeg:codex'], { worker: '' }, { worker: 'a b' }]) {
    const k = await fixture();
    const started = await emit(k, { action: 'task-start', goal: 'x', route: 'delegated', channels, permissions: { mode: 'write', allowedPaths: [] } });
    assert.equal(started.result.accepted, false, JSON.stringify(channels));
    assert.equal((await readState(k.directory)).tasks[taskKey(k.projectId, k.taskId)], undefined);
  }
});

test('supersedes：换新 packageId 返修继承轮次、旧包收尾，被接替的包不再要求审查', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' }, { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'FIX' }]);
  let result;
  for (const [index, id] of ['fix1', 'fix2', 'fix3'].entries()) {
    result = (await packages(f, [{ packageId: id, role: 'worker', status: 'dispatched', supersedes: index ? `fix${index}` : 'w1' }])).result;
    assert.equal(result.accepted, true, JSON.stringify(result));
    await packages(f, [{ packageId: id, status: 'consumed', deliveredRef: `v${index + 2}` }]);
  }
  assert.deepEqual(result.repairLimitPackages, ['fix3']);
  const task = await taskOf(f);
  assert.equal(task.packages.fix3.attempts, 3);
  assert.equal(task.packages.w1.supersededBy, 'fix1');
  let ended = await emit(f, { action: 'task-end', validation, finalRef: 'm1' });
  assert.deepEqual(ended.result.missing, ['review:fix3']);
  await packages(f, [{ packageId: 'r2', role: 'reviewer', status: 'consumed', reviews: 'fix3', reviewedRef: 'v4', verdict: 'PASS' }]);
  ended = await emit(f, { action: 'task-end', validation, finalRef: 'm1' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('supersedes：在途旧包记为 canceled；目标不存在、异角色、已被接替或给已有包补声明都拒绝', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }, { packageId: 'r1', role: 'reviewer', status: 'dispatched' }]);
  await packages(f, [{ packageId: 'w2', role: 'worker', status: 'dispatched', supersedes: 'w1' }]);
  assert.equal((await taskOf(f)).packages.w1.status, 'canceled');
  for (const item of [
    { packageId: 'w3', role: 'worker', status: 'dispatched', supersedes: 'nope' },
    { packageId: 'w3', role: 'worker', status: 'dispatched', supersedes: 'r1' },
    { packageId: 'w3', role: 'worker', status: 'dispatched', supersedes: 'w1' },
    { packageId: 'r1', supersedes: 'w2' },
  ]) assert.equal((await packages(f, [item])).result.reason, 'PACKAGE', JSON.stringify(item));
});

test('已安排审查的 worker 包：审查缺项不能豁免、不能改标 waived；canceled 仍可放弃，从未审查的包照常豁免', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v2' }, { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'PASS' }], { validation });
  for (const step of ['review', 'review:w1']) {
    const ended = await emit(f, { action: 'task-end', finalRef: 'm1', waivers: [{ step, reason: '审查后只改了注释' }] });
    assert.deepEqual(ended.result.missing, ['review:w1']);
    assert.match(ended.result.message, /不能豁免审查缺项.*supersedes/);
  }
  assert.equal((await packages(f, [{ packageId: 'w1', status: 'waived' }])).result.reason, 'PACKAGE');
  assert.match((await event(f, 'Stop')).reason, /review:w1/);
  await packages(f, [{ packageId: 'w1', status: 'canceled' }]);
  assert.equal((await emit(f, { action: 'task-end', finalRef: 'm1' })).result.accepted, true);

  const g = await fixture();
  await delegated(g);
  await packages(g, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' }], { validation });
  assert.equal((await emit(g, { action: 'task-end', finalRef: 'm1', waivers: [{ step: 'review:w1', reason: '只改文档，用户同意免审' }] })).result.accepted, true);
  const h = await fixture();
  await delegated(h);
  await packages(h, [{ packageId: 'w1', role: 'worker', status: 'waived' }], { validation });
  assert.equal((await emit(h, { action: 'task-end', finalRef: 'm1' })).result.accepted, true);
});

test('已审结论沿 supersedes 继承：接替包不能借新包号豁免；取消而无结论的审查不算已审；被接替的包不能再改状态', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' }, { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'FIX' }]);
  await packages(f, [{ packageId: 'w2', role: 'worker', status: 'consumed', deliveredRef: 'v2', supersedes: 'w1' }], { validation });
  const ended = await emit(f, { action: 'task-end', finalRef: 'm1', waivers: [{ step: 'review:w2', reason: '小改动' }] });
  assert.deepEqual(ended.result.missing, ['review:w2']);
  assert.equal((await packages(f, [{ packageId: 'w2', status: 'waived' }])).result.reason, 'PACKAGE');
  assert.equal((await packages(f, [{ packageId: 'w1', status: 'dispatched' }])).result.reason, 'PACKAGE');

  const g = await fixture();
  await delegated(g);
  await packages(g, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' }, { packageId: 'r1', role: 'reviewer', status: 'canceled', reviews: 'w1' }], { validation });
  const waived = await emit(g, { action: 'task-end', finalRef: 'm1', waivers: [{ step: 'review:w1', reason: '审查人中途取消，用户同意免审' }] });
  assert.equal(waived.result.accepted, true, JSON.stringify(waived.result));
});

test('Stop 在途提示按通道区分：全为内置子代理时说明宿主会通知，含 Codeg 包时要求阻塞等待', async () => {
  const f = await fixture();
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched', handle: 'agent-x', channel: 'builtin:general-purpose' }]);
  const builtin = await event(f, 'Stop');
  assert.match(builtin.reason, /内置子代理执行，结束时宿主会通知本会话/);
  assert.doesNotMatch(builtin.reason, /get_delegation_status/);
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  await packages(f, [{ packageId: 'w2', role: 'worker', status: 'dispatched', handle: 'task-9', channel: 'codeg:codex' }]);
  assert.match((await event(f, 'Stop')).reason, /get_delegation_status/);
});

test('内置子代理调用 signal：回执说明没有身份，状态不变；其他工具事件照常放行', async () => {
  const f = await fixture();
  const file = path.join(f.directory, 'state.json');
  const before = await readFile(file, 'utf8');
  const sub = { session_id: f.sessionId, agent_id: 'agent-1', agent_type: 'general-purpose', tool_name: 'Bash', tool_response: { output: '{}' } };
  for (const command of [`node "${entry}" signal --input c.json`, `wf=x; node "${entry}" signal --input c.json`]) {
    const output = await event(f, 'PostToolUse', { ...sub, tool_input: { command } });
    assert.match(output.hookSpecificOutput.additionalContext, /内置子代理.*没有自己的 workflow 身份/, command);
  }
  assert.deepEqual(await event(f, 'PostToolUse', { ...sub, tool_input: { command: 'npm test' } }), {});
  assert.equal(await readFile(file, 'utf8'), before);
});
