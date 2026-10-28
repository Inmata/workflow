import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { digest, mutate, pendingLifecycleEvents, readState, withLock } from '../src/store.mjs';
import { taskKey } from '../src/protocol.mjs';
import { createPending } from '../src/knowledge.mjs';
import { assertRoundCheck, deadPid, deliver, emit, event, fixture, identity, start } from './helpers.mjs';

test('交付不要求复盘：Stop 每回合最多挡一次提醒 task-end，重启、跨 turn 与压缩不补偿经验', async () => {
  const f = await fixture();
  await start(f);
  assert.equal((await deliver(f)).result.accepted, true);
  assertRoundCheck(await event(f, 'Stop'));
  assert.deepEqual(await event(f, 'Stop'), {});
  const persisted = await readState(f.directory);
  assert.equal(persisted.tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  assertRoundCheck(await event(f, 'Stop'));
  await start(f);
  await deliver(f, null, 'delivery-2');
  const beforeCompact = await identity(f);
  await event(f, 'PreCompact');
  assert.deepEqual(await event(f, 'PostCompact'), {});
  await event(f, 'SessionStart', { source: 'compact' });
  assert.deepEqual(await identity(f), beforeCompact);
  // 压缩不开新回合，本回合已挡过。
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
  assert.equal((await emit(f, { action: 'task-end' })).result.accepted, true);
});
test('V03/V08 未绑定任务、operation-only、waiting-user 不核对；executing 挡一次', async () => {
  const f = await fixture();
  assert.deepEqual(await event(f, 'Stop'), {});
  await start(f);
  for (const phase of ['operation-only', 'waiting-user']) {
    await emit(f, { action: 'phase', phase });
    assert.deepEqual(await event(f, 'Stop', { last_assistant_message: '这里是否已经完成？' }), {});
  }
  await emit(f, { action: 'phase', phase: 'executing' });
  assertRoundCheck(await event(f, 'Stop'));
  await emit(f, { action: 'phase', phase: 'unknown' });
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].repairIssued, false);
});
test('V06 有理由无新经验和可定位待办放行，伪造 updated 拒绝且不改变阶段', async () => {
  const f = await fixture();
  await start(f);
  const invalid = await deliver(f, { status: 'updated', transactionIds: ['fake'] });
  assert.equal(invalid.result.accepted, false);
  assertRoundCheck(await event(f, 'Stop'));
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
test('P01 两个 Lead 会话共用任务时，结束其中一个不挂起任务；最后一个结束才保存待办', async () => {
  const f = await fixture();
  await start(f);
  // 第二个 Lead 会话显式接续同一任务。
  const other = { ...f, sessionId: 'session-2', turnId: 'turn-2b' };
  await event(other, 'UserPromptSubmit');
  const relayed = await emit(other, { action: 'task-start' });
  assert.equal(relayed.result.accepted, true, JSON.stringify(relayed.result));
  await event(f, 'Interrupt');
  let state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 0);
  assert.equal(Object.values(state.sessions).find(s => s.sessionId === 'session-1').interrupted, true);
  await event(other, 'SessionEnd');
  state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'suspended');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
});
test('P01 旧状态的会话缺 interrupted 字段时保守按未中断，不挂起仍在用的任务', async () => {
  const f = await fixture();
  await start(f);
  // 第二个 Lead 会话接续同一任务后，清掉它的 interrupted/ticket 字段，模拟升级前的旧状态。
  const other = { ...f, sessionId: 'session-2', turnId: 'turn-2b' };
  await event(other, 'UserPromptSubmit');
  await emit(other, { action: 'task-start' });
  await mutate(f.directory, async state => {
    for (const session of Object.values(state.sessions)) if (session.sessionId !== f.sessionId) { delete session.interrupted; delete session.lastSeenAt; }
  });
  await event(f, 'Interrupt');
  const state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 0);
});
test('P01 结束事件在锁竞争时先落盘，下一次入口幂等消费，重复事件只生效一次', async () => {
  const f = await fixture();
  await start(f);
  // 状态锁被短暂占用：Interrupt 事件独立落盘但拿不到锁，不声称已应用。
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withLock(f.directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const contended = await event(f, 'Interrupt');
  assert.match(contended.systemMessage, /已另存为本机待办/);
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  release();
  await holder;
  // 下一次入口消费待办：任务挂起，票据失效。
  f.turnId = 'turn-after-interrupt';
  await event(f, 'UserPromptSubmit');
  let state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'suspended');
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.interrupted, false, '新回合要能继续接续');
  assert.equal(session.turnId, 'turn-after-interrupt');
  // 重复结束事件不再增加中断轮次或待办。
  await event(f, 'SessionEnd');
  await event(f, 'SessionEnd');
  state = await readState(f.directory);
  assert.equal(Object.values(state.pending).filter(item => item.kind === 'business-incomplete').length, 1);
  assert.equal(Object.values(state.sessions).find(item => item.sessionId === f.sessionId).interruptEpoch, 2);
});
test('P01 旧回合的结束事件迟到：不打断新回合，只保留待办', async () => {
  const f = await fixture();
  await start(f);
  f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  f.turnId = 'turn-1';
  await event(f, 'SessionEnd');
  const state = await readState(f.directory);
  const session = Object.values(state.sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.turnId, 'turn-2');
  assert.equal(session.interrupted, false);
  assert.ok(session.ticket);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  const pending = Object.values(state.pending).filter(item => item.kind === 'business-incomplete');
  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /晚于新回合/);
});
test('P01 结束事件缺会话关联时保留待办并解释，不猜身份', async () => {
  const f = await fixture();
  await start(f);
  await event({ ...f, sessionId: 'session-never-registered' }, 'SessionEnd');
  const state = await readState(f.directory);
  assert.equal(state.tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  assert.equal((await pendingLifecycleEvents(f.directory)).deferred.length, 1);
});
test('P01 残留的恢复 guard 不再让连续请求一直 LOCKED：死持有者锁可回收，损坏 guard 给诊断', async () => {
  const f = await fixture();
  await start(f);
  const locks = path.join(f.directory, 'locks');
  await mkdir(locks, { recursive: true });
  const lockFile = path.join(locks, `${digest('state')}.lock`);
  const guardFile = `${lockFile}.recovery`;
  const dead = deadPid();  // 崩溃进程留下的锁与 guard：第二次请求能辨认并回收，而不是永远 LOCKED。
  await writeFile(lockFile, JSON.stringify({ pid: dead, token: 'dead-token', name: 'state', createdAt: new Date(0).toISOString() }));
  await writeFile(guardFile, JSON.stringify({ pid: dead, name: 'state', createdAt: new Date(0).toISOString() }));
  const recovered = await event(f, 'Stop');
  assert.equal(recovered.systemMessage, undefined, JSON.stringify(recovered));
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'active');
  // 损坏的 guard 不猜成死锁：保留现场并给出可执行诊断。
  await writeFile(lockFile, JSON.stringify({ pid: dead, token: 'second-dead-token', name: 'state', createdAt: new Date(0).toISOString() }));
  await writeFile(guardFile, '{broken');
  const broken = await event(f, 'Stop');
  assert.match(broken.systemMessage, /LOCKED/);
  assert.ok(broken.systemMessage.includes(path.basename(guardFile)));
  assert.equal(await readFile(guardFile, 'utf8'), '{broken');
  assert.ok(await readFile(lockFile, 'utf8'));
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
  assertRoundCheck(await event(f, 'Stop'));
});
test('pending-only 兼容字段不再为无经验交付制造待办', async () => {
  const f = await fixture({ coexistenceMode: 'pending-only' });
  await start(f);
  await deliver(f);
  assertRoundCheck(await event(f, 'Stop'));
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
