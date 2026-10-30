// 合成 fixture（synthetic）：F11 route/通道声明契约、F12 已审包取消与返修 ref、F14 首次声明只读诊断免审。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readState } from '../src/store.mjs';
import { gateReport, taskKey } from '../src/protocol.mjs';
import { emit, fixture, gitFixture } from './helpers.mjs';

const delegated = (f, extra = {}) => emit(f, { action: 'task-start', goal: '分工任务', route: 'delegated', permissions: { mode: 'write', allowedPaths: ['README.md'] }, ...extra });
const packages = (f, items, extra = {}) => emit(f, { action: 'packages', packages: items, ...extra });
const taskOf = async f => (await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)];
const validation = { ref: 'm1', evidence: ['npm test 通过'] };

test('F11 route 只决定门禁：三种合法分流保持原契约，用户指定通道的偏离必须由同一信号 change 记录', async () => {
  // operation-only：不进入 spec/delegated 门禁，也不要求工作包或审查。
  const f = await fixture();
  const channels = { worker: 'codeg:claude_code', reviewer: 'codeg:codex' };
  const started = await emit(f, { action: 'task-start', goal: '查看状态', route: 'operation-only', channels, permissions: { mode: 'read-only', allowedPaths: [] } });
  assert.equal(started.result.accepted, true, JSON.stringify(started.result));
  assert.deepEqual((await taskOf(f)).channels, channels);
  const ended = await emit(f, { action: 'task-end' });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
  assert.deepEqual((await taskOf(f)).packages, {});

  // delegated：通道偏离没有 change 时按 CHANNEL 拒绝，同一信号列出该包后接受；门禁不会因 change 消失。
  const g = await gitFixture(['m1']);
  await delegated(g, { channels });
  assert.equal((await packages(g, [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'builtin:general-purpose' }])).result.reason, 'CHANNEL');
  const changed = await packages(g, [{ packageId: 'w1', role: 'worker', status: 'dispatched', channel: 'builtin:general-purpose' }], { change: { summary: '改用内置子代理', reason: '用户同意：Codeg 额度用尽', packages: ['w1'] } });
  assert.equal(changed.result.accepted, true, JSON.stringify(changed.result));
  await packages(g, [{ packageId: 'w1', status: 'consumed', deliveredRef: 'v1' }], { validation });
  const gated = await emit(g, { action: 'task-end', finalRef: 'm1' });
  assert.deepEqual(gated.result.missing, ['review:w1'], 'route=delegated 的审查门禁不因通道 change 消失');
});

test('F12 已有 PASS 审查的 worker 包不能改 canceled 退出门禁，原记录不变', async () => {
  const f = await gitFixture(['m1']);
  await delegated(f);
  await packages(f, [
    { packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' },
    { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'PASS' },
  ], { validation });
  const before = structuredClone((await taskOf(f)).packages.w1);
  const denied = await packages(f, [{ packageId: 'w1', status: 'canceled' }]);
  assert.equal(denied.result.accepted, false, JSON.stringify(denied.result));
  assert.equal(denied.result.reason, 'PACKAGE');
  assert.match(denied.result.message, /PASS/);
  assert.match(denied.result.message, /canceled/);
  assert.deepEqual((await taskOf(f)).packages.w1, before, '被拒绝的取消不能改写原包记录或交付历史');
  const ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('F12 未审包仍可取消；最终 ref 仍含被取消改动时门禁只核对声明，不能识别代码级集成', async () => {
  const f = await gitFixture(['m1']);
  await delegated(f);
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' }]);
  assert.equal((await packages(f, [{ packageId: 'w1', status: 'canceled' }])).result.accepted, true);
  // 边界：门禁只确认该包没有未完成的声明，不证明 v1 的改动真的从最终 ref 消失。
  const ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation: { ref: 'm1', evidence: ['合成边界样例：最终 ref 仍可能包含被取消改动'] } });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
  assert.match(ended.result.gate, /declared-records-consistent/);
});

test('F12 同包返修后旧 PASS 不再匹配，新 reviewedRef 对上最终交付才通过', async () => {
  const f = await gitFixture(['m1']);
  await delegated(f);
  await packages(f, [
    { packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' },
    { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'PASS' },
  ], { validation });
  await packages(f, [{ packageId: 'w1', status: 'consumed', deliveredRef: 'v2' }]);
  let ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation });
  assert.deepEqual(ended.result.missing, ['review:w1']);
  await packages(f, [{ packageId: 'r1', status: 'consumed', reviews: 'w1', reviewedRef: 'v2', verdict: 'PASS' }]);
  ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('F12 新包 supersedes 只在创建时声明；新包需要自己的 PASS 审查', async () => {
  const f = await gitFixture(['m1']);
  await delegated(f);
  await packages(f, [
    { packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1' },
    { packageId: 'r1', role: 'reviewer', status: 'consumed', reviews: 'w1', reviewedRef: 'v1', verdict: 'PASS' },
  ], { validation });
  assert.equal((await packages(f, [{ packageId: 'w2', role: 'worker', status: 'dispatched', supersedes: 'w1' }])).result.accepted, true);
  assert.equal((await taskOf(f)).packages.w1.supersededBy, 'w2');
  const late = await packages(f, [{ packageId: 'w2', supersedes: 'r1' }]);
  assert.equal(late.result.reason, 'PACKAGE');
  await packages(f, [{ packageId: 'w2', status: 'consumed', deliveredRef: 'v2' }]);
  let ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation });
  assert.deepEqual(ended.result.missing, ['review:w2'], '接替包不能继承旧包的审查结论');
  await packages(f, [{ packageId: 'r2', role: 'reviewer', status: 'consumed', reviews: 'w2', reviewedRef: 'v2', verdict: 'PASS' }]);
  ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

const diagnostic = (extra = {}) => ({ purpose: '核对 README 与发布说明是否一致', scope: ['README.md'], reason: '只读调查，不修改项目', ...extra });

test('F14 首次建包声明只读诊断免审：进入 gateReport，交付有可定位结论即可通过', async () => {
  const f = await gitFixture(['m1']);
  await delegated(f);
  const declared = await packages(f, [{ packageId: 'd1', role: 'worker', status: 'dispatched', diagnostic: diagnostic() }]);
  assert.equal(declared.result.accepted, true, JSON.stringify(declared.result));
  const delivered = await packages(f, [{ packageId: 'd1', status: 'consumed', note: '结论：README 与发布说明一致；证据 README.md 第 1 行、docs/usage.md' }], { validation });
  assert.equal(delivered.result.accepted, true, JSON.stringify(delivered.result));
  const task = await taskOf(f);
  const report = gateReport((await readState(f.directory)), task, 'm1', f.project);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.diagnostic, ['d1'], '声明进入 gateReport，供 task show 与审查核对');
  const ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));
});

test('F14 空理由、缺交付结论、实现包、事后补声明与接替已审包都被拒；历史未声明包仍需审查', async () => {
  const f = await gitFixture(['m1']);
  await delegated(f);
  for (const [item, pattern] of [
    [{ packageId: 'bad1', role: 'worker', status: 'dispatched', diagnostic: diagnostic({ reason: '  ' }) }, /reason/],
    [{ packageId: 'bad2', role: 'worker', status: 'dispatched', diagnostic: diagnostic({ scope: [] }) }, /scope/],
    [{ packageId: 'bad3', role: 'worker', status: 'dispatched', diagnostic: diagnostic({ scope: ['C:/绝对路径'] }) }, /scope/],
    [{ packageId: 'bad4', role: 'worker', status: 'consumed', deliveredRef: 'v1', diagnostic: diagnostic() }, /诊断|deliveredRef|实现/],
    [{ packageId: 'bad5', role: 'reviewer', status: 'dispatched', diagnostic: diagnostic() }, /worker/],
  ]) {
    const result = (await packages(f, [item])).result;
    assert.equal(result.reason, 'PACKAGE', JSON.stringify(item));
    assert.match(result.message, pattern);
  }
  // 事后补声明与修改声明都拒绝。
  await packages(f, [{ packageId: 'w1', role: 'worker', status: 'dispatched' }]);
  assert.equal((await packages(f, [{ packageId: 'w1', diagnostic: diagnostic() }])).result.reason, 'PACKAGE');
  await packages(f, [{ packageId: 'd1', role: 'worker', status: 'dispatched', diagnostic: diagnostic() }]);
  assert.equal((await packages(f, [{ packageId: 'd1', diagnostic: diagnostic({ reason: '换个理由' }) }])).result.reason, 'PACKAGE');
  // 诊断包不能靠 supersedes 接替已有审查的 worker 包来豁免审查。
  await packages(f, [{ packageId: 'w2', role: 'worker', status: 'consumed', deliveredRef: 'v2' }, { packageId: 'r2', role: 'reviewer', status: 'consumed', reviews: 'w2', reviewedRef: 'v2', verdict: 'PASS' }]);
  assert.equal((await packages(f, [{ packageId: 'd2', role: 'worker', status: 'dispatched', supersedes: 'w2', diagnostic: diagnostic() }])).result.reason, 'PACKAGE');
  // 清掉未交付的 w1（未审包可合法取消），让门禁只关注诊断包结论。
  assert.equal((await packages(f, [{ packageId: 'w1', status: 'canceled' }])).result.accepted, true);

  // 缺交付结论：门禁列 diagnostic:d1，且不能用 waiver 抵扣；补上可定位结论后接受。
  await packages(f, [{ packageId: 'd1', status: 'consumed' }], { validation });
  let ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation, waivers: [{ step: 'diagnostic:d1', reason: '结论已在会话里' }] });
  assert.deepEqual(ended.result.missing, ['diagnostic:d1']);
  await packages(f, [{ packageId: 'd1', note: '结论：README 无需修改；证据 README.md 第 1 行' }]);
  ended = await emit(f, { action: 'task-end', finalRef: 'm1', validation });
  assert.equal(ended.result.accepted, true, JSON.stringify(ended.result));

  // 历史未声明诊断的包仍按原契约要求审查。
  const g = await gitFixture(['m1']);
  await delegated(g);
  await packages(g, [{ packageId: 'w1', role: 'worker', status: 'consumed', deliveredRef: 'v1', note: '结论：已核对' }], { validation });
  const missing = await emit(g, { action: 'task-end', finalRef: 'm1', validation });
  assert.deepEqual(missing.result.missing, ['review:w1']);
});
