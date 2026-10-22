import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { digest, readState, withLock } from '../src/store.mjs';
import { applyKnowledge, inspectKnowledge, recoverTransaction } from '../src/knowledge.mjs';
import { event, fixture, identity, root, start, temporary } from './helpers.mjs';

test('V11 活锁竞争不抢占，持有者释放后可继续', async () => {
  const directory = await temporary('lock-');
  let acquired, release;
  const entered = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withLock(directory, 'shared', async () => { acquired(); await gate; return 'done'; });
  await entered;
  await assert.rejects(withLock(directory, 'shared', async () => 'bad'), { code: 'LOCKED' });
  release();
  assert.equal(await owner, 'done');
  assert.equal(await withLock(directory, 'shared', async () => 'next'), 'next');
});
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
