import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { readState } from '../src/store.mjs';
import { taskKey } from '../src/protocol.mjs';
import { createPending } from '../src/knowledge.mjs';
import { deliver, emit, event, fixture, identity, start } from './helpers.mjs';

test('交付不要求复盘，重复 Stop、重启、跨 turn 与压缩均不补偿', async () => {
  const f = await fixture();
  await start(f);
  assert.equal((await deliver(f)).result.accepted, true);
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.deepEqual(await event(f, 'Stop'), {});
  const persisted = await readState(f.directory);
  assert.equal(persisted.tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  assert.deepEqual(await event(f, 'Stop'), {});
  await start(f);
  await deliver(f, null, 'delivery-2');
  const beforeCompact = await identity(f);
  await event(f, 'PreCompact');
  assert.deepEqual(await event(f, 'PostCompact'), {});
  await event(f, 'SessionStart', { source: 'compact' });
  assert.deepEqual(await identity(f), beforeCompact);
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  assert.equal((await emit(f, { action: 'task-end' })).result.accepted, true);
});
test('V03/V08 unknown、operation-only、executing、waiting-user 均不补偿', async () => {
  const f = await fixture();
  assert.deepEqual(await event(f, 'Stop'), {});
  await start(f);
  for (const phase of ['operation-only', 'executing', 'waiting-user', 'unknown']) {
    await emit(f, { action: 'phase', phase });
    assert.deepEqual(await event(f, 'Stop', { last_assistant_message: '这里是否已经完成？' }), {});
  }
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
});
test('V06 有理由无新经验和可定位待办放行，伪造 updated 拒绝且不改变阶段', async () => {
  const f = await fixture();
  await start(f);
  const invalid = await deliver(f, { status: 'updated', transactionIds: ['fake'] });
  assert.equal(invalid.result.accepted, false);
  assert.deepEqual(await event(f, 'Stop'), {});
  await deliver(f, { status: 'no-new-learning', reason: '已有资料完整承接' });
  assert.deepEqual(await event(f, 'Stop'), {});
  const pending = await createPending(f.directory, { ...await identity(f), reason: '证据尚缺', evidence: ['test:原始记录'] });
  await deliver(f, { status: 'pending-recovery', pendingId: pending.pendingId, reason: '待补原始证据' }, 'delivery-2');
  assert.deepEqual(await event(f, 'Stop'), {});
});
test('V09 中断撤销票据，迟到信号拒绝，新用户回合不恢复业务', async () => {
  const f = await fixture();
  await start(f);
  const stale = { ...await identity(f), taskId: f.taskId, signalId: 'late', action: 'phase', phase: 'delivering', deliveryId: 'late-delivery' };
  await event(f, 'Interrupt');
  const late = await emit(f, stale);
  assert.equal(late.result.accepted, false);
  assert.deepEqual(await event(f, 'Stop'), {});
  f.turnId = 'turn-after-interrupt';
  await event(f, 'UserPromptSubmit');
  assert.deepEqual(await event(f, 'Stop'), {});
  const state = await readState(f.directory);
  assert.ok(Object.values(state.pending).some(p => p.kind === 'business-incomplete'));
});
test('同一 signalId 幂等重放，错误 revision 与篡改正文拒绝', async () => {
  const f = await fixture();
  await start(f);
  const first = await emit(f, { action: 'phase', phase: 'executing', signalId: 'stable-signal' });
  const repeated = await emit(f, first.payload);
  assert.equal(repeated.result.accepted, true);
  assert.equal(repeated.result.replayed, true);
  const changed = await emit(f, { ...first.payload, phase: 'delivering', deliveryId: 'other' });
  assert.equal(changed.result.accepted, false);
  const stale = await emit(f, { action: 'phase', phase: 'waiting-user', expectedRevision: 0 });
  assert.equal(stale.result.accepted, false);
});
test('V02 不同 session/turn 不消费当前回执或 Stop 预算', async () => {
  const f = await fixture();
  await start(f);
  await deliver(f);
  assert.deepEqual(await event(f, 'Stop', { session_id: 'other-session' }), {});
  assert.deepEqual(await event(f, 'Stop', { turn_id: 'other-turn' }), {});
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  assert.deepEqual(await event(f, 'Stop'), {});
});
test('pending-only 兼容字段不再为无经验交付制造待办', async () => {
  const f = await fixture({ coexistenceMode: 'pending-only' });
  await start(f);
  await deliver(f);
  assert.deepEqual(await event(f, 'Stop'), {});
  const state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  assert.equal(Object.values(state.pending).filter(p => p.kind === 'knowledge-pending').length, 0);
});
test('未知 schema 和损坏状态不阻断宿主，原字节保持', async () => {
  const f = await fixture();
  const file = path.join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.schemaVersion = 999;
  await writeFile(file, JSON.stringify(state));
  const before = await readFile(file, 'utf8');
  assert.equal((await event(f, 'Stop')).decision, undefined);
  assert.equal(await readFile(file, 'utf8'), before);
  await writeFile(file, '{broken');
  assert.equal((await event(f, 'Stop')).decision, undefined);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
