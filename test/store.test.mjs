import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { digest, readState, withLock, recordLifecycleEvent, pendingLifecycleEvents } from '../src/store.mjs';
import { applyKnowledge, inspectKnowledge, recoverTransaction } from '../src/knowledge.mjs';
import { deadPid, event, fixture, identity, root, start, temporary } from './helpers.mjs';

test('V11 活锁竞争不抢占，持有者释放后可继续', async () => {
  const directory = await temporary('lock-');
  let acquired, release;
  const entered = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withLock(directory, 'shared', async () => { acquired(); await gate; return 'done'; });
  await entered;
  await assert.rejects(withLock(directory, 'shared', async () => 'bad', { budgetMs: 120 }), { code: 'LOCKED' });
  release();
  assert.equal(await owner, 'done');
  assert.equal(await withLock(directory, 'shared', async () => 'next'), 'next');
});
test('P01 短暂锁争用有总预算重试：持有者释放后请求成功，预算耗尽才 LOCKED', async () => {
  const directory = await temporary('lock-wait-');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withLock(directory, 'state', async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiter = withLock(directory, 'state', async () => 'waited', { budgetMs: 1500 });
  setTimeout(release, 300);
  assert.equal(await waiter, 'waited');
  await owner;
  // 预算耗尽后保守失败，不按锁年龄抢活锁：持有者仍在运行时锁保持原位。
  let releaseHeld;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const owner2 = withLock(directory, 'state', async () => { await held; });
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(withLock(directory, 'state', async () => 'no', { budgetMs: 100 }), { code: 'LOCKED' });
  assert.equal((await readdir(path.join(directory, 'locks'))).filter(name => name.endsWith('.lock')).length, 1);
  releaseHeld();
  await owner2;
});
test('P01 死持有者残留锁可回收；空或损坏的恢复 guard 不猜成死锁，给出可执行诊断', async () => {
  const directory = await temporary('lock-guard-');
  const locks = path.join(directory, 'locks');
  await mkdir(locks, { recursive: true });
  const lockFile = path.join(locks, `${digest('state')}.lock`);
  const guardFile = `${lockFile}.recovery`;
  const dead = deadPid();
  // 死持有者 + 损坏 guard：不删除 guard，诊断指向具体文件。
  await writeFile(lockFile, JSON.stringify({ pid: dead, token: 't-dead', name: 'state', createdAt: new Date(0).toISOString() }));
  await writeFile(guardFile, '{}');
  const old = new Date(Date.now() - 60_000);
  await utimes(guardFile, old, old);
  await assert.rejects(withLock(directory, 'state', async () => 'no', { budgetMs: 100 }), error => {
    assert.equal(error.code, 'LOCKED');
    assert.match(error.message, /guard/);
    assert.ok(error.message.includes(path.basename(guardFile)));
    return true;
  });
  assert.equal(await readFile(guardFile, 'utf8'), '{}');
  assert.ok(await readFile(lockFile, 'utf8'));
  // 死进程遗留的 guard 由记录中的 pid 辨认后回收，旧锁随后可安全回收。
  await writeFile(guardFile, JSON.stringify({ pid: dead, name: 'state', createdAt: new Date(0).toISOString() }));
  assert.equal(await withLock(directory, 'state', async () => 'recovered', { budgetMs: 800 }), 'recovered');
  assert.deepEqual((await readdir(path.join(directory, 'retired-locks'))).some(name => name.includes('stale-recovery')), true);
});
test('P01 生命周期结束事件独立落盘，未消费前保留待办并可用于诊断', async () => {
  const directory = await temporary('lifecycle-');
  await recordLifecycleEvent(directory, { kind: 'lifecycle', event: 'SessionEnd', projectId: 'p', sessionId: 's', turnId: 't', at: new Date().toISOString() });
  const pending = await pendingLifecycleEvents(directory);
  assert.equal(pending.queued.length, 1);
  assert.deepEqual(pending.deferred, []);
});
// 运行中的活进程不能回收；用一个已退出子进程的 pid 作死持有者。
test('V11 真实子进程写入后退出：旧锁只凭操作系统确认进程退出回收，事务辨认成功', async () => {
  const f = await fixture();
  await start(f);
  const before = await inspectKnowledge(f.directory, f.project, 'README.md');
  const request = { ...await identity(f), changes: [{ path: 'README.md', baseline: before.fingerprint, content: '# 新事实\n', responsibility: '项目事实', reason: '真实崩溃测试', evidence: ['test:crash'], candidateIds: [] }] };
  const moduleURL = pathToFileURL(path.join(root, 'src', 'knowledge.mjs')).href;
  const source = `import {applyKnowledge} from ${JSON.stringify(moduleURL)}; await applyKnowledge(process.argv[1], JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')), {checkpoint(stage) {if(stage==='written') process.exit(23)}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.directory, Buffer.from(JSON.stringify(request)).toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 23, child.stderr);
  const tx = Object.values((await readState(f.directory)).transactions)[0];
  assert.equal(tx.files[0].status, 'prepared');
  const recovered = await recoverTransaction(f.directory, tx.transactionId, f.project);
  assert.equal(recovered.status, 'applied');
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), '# 新事实\n');
});
test('V11 快照目录不可写不改正文，状态可写时保留候选待办', async () => {
  const f = await fixture();
  await start(f);
  const before = await inspectKnowledge(f.directory, f.project, 'README.md');
  await writeFile(path.join(f.directory, 'transactions'), '故意占用目录名称');
  const result = await applyKnowledge(f.directory, { ...await identity(f), changes: [{ path: 'README.md', baseline: before.fingerprint, content: '# 不应写入\n', responsibility: '项目资料', reason: '故障注入', evidence: ['test:snapshot-failure'], candidateIds: [] }] });
  assert.equal(result.status, 'pending');
  assert.ok(result.pendingId);
  assert.equal(await readFile(path.join(f.project, 'README.md'), 'utf8'), before.content);
});
test('V11 hook 锁超时/占用保守放行，不消费任务预算', async () => {
  const f = await fixture();
  await start(f);
  await mkdir(path.join(f.directory, 'locks'), { recursive: true });
  const lockFile = path.join(f.directory, 'locks', `${digest('state')}.lock`);
  await writeFile(lockFile, JSON.stringify({ pid: process.pid }));
  assert.equal((await event(f, 'Stop')).decision, undefined);
  const state = await readState(f.directory);
  assert.equal(Object.values(state.tasks)[0].repairIssued, false);
});
