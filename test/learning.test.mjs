import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { capture, feedback, maturityFor, readEntries, readItems, reviseKnowledge, selectKnowledge } from '../src/learning.mjs';
import { projectContext } from '../src/context.mjs';
import { learningConfig, setLearningConfig, setLearningEnabled, projectFor } from '../src/learning-config.mjs';
import { dueReason, learningStatus, recoverReview, reviewOnce } from '../src/review.mjs';
import { preflight, runProcess } from '../src/runner.mjs';
import { schedulePreview, installSchedule, removeSchedule, tick } from '../src/scheduler.mjs';
import { readState, mutate } from '../src/store.mjs';
import { applyKnowledge, inspectKnowledge, createPending } from '../src/knowledge.mjs';
import { taskKey } from '../src/protocol.mjs';
import { event, fixture, identity, start, emit, deliver, entry, cli } from './helpers.mjs';

async function observe(f, n, extra = {}) {
  return capture(f.directory, { ...await identity(f), observation: { id: 'o' + n, incidentId: 'incident-' + n, kind: 'success', summary: '登录超时修复后验证成功 ' + n, conditions: '登录接口', evidence: ['test:login-' + n], paths: ['src/login.mjs'], verified: true, ...extra } });
}
async function finish(f) { await emit(f, { action: 'task-end' }); await event(f, 'SessionEnd'); }
function fakeOptions(extra = {}) {
  return {
    preflight: async () => ({ status: 'capabilities-verified' }),
    runner: async (config, prompt) => {
      const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
      return { status: 'completed', usage: { input_tokens: 100, output_tokens: 50 }, answer: { decisions: data.observations.map(o => {
        const previous = data.knowledge.find(e => e.id === o.knowledgeId);
        return { observationIds: [o.id], action: previous ? 'revise' : 'create', targetId: previous?.id || null, supersedes: null, title: previous?.title || '登录超时经验 ' + o.id, summary: previous?.summary || o.summary, conditions: o.conditions, type: 'method', importance: previous?.importance || 'important', status: 'active', paths: previous?.scope.paths || ['src/login.mjs'], version: previous?.scope.version || null, tags: ['登录', 'timeout'], reason: '根据本批验证结果整理' };
      }) } };
    },
    ...extra,
  };
}
test('9 份材料关闭会话后持久保存；跨日新会话可见，年龄触发与数量独立', async () => {
  const f = await fixture(); await start(f);
  for (let i = 1; i <= 9; i++) await observe(f, i);
  await finish(f);
  f.sessionId = 'session-2'; f.turnId = 'turn-2';
  await event(f, 'UserPromptSubmit');
  const project = await projectFor(f.directory, f.project);
  const items = await readItems(f.directory, project, 'inbox');
  assert.equal(items.length, 9);
  const config = (await learningConfig(f.directory, project)).values;
  assert.equal(dueReason(items, config, new Date(items[0].createdAt)), null);
  assert.equal(dueReason(items, config, new Date(Date.parse(items[0].createdAt) + 25 * 3600000)), 'age');
  assert.equal((await getOwner(f)), 'session-2');
});
async function getOwner(f) { return (await readState(f.directory)).projects[f.projectId].ownerSessionId; }

test('配置个人默认与项目覆盖；非法配置保留旧文件', async () => {
  const f = await fixture();
  await setLearningConfig(f.directory, f.project, { maxRunMinutes: 60, pendingThreshold: 20, model: 'my-model' }, true);
  await setLearningConfig(f.directory, f.project, { pendingThreshold: 8, checkIntervalMinutes: 45 });
  const config = await learningConfig(f.directory, await projectFor(f.directory, f.project));
  assert.equal(config.values.maxRunMinutes, 60);
  assert.equal(config.values.pendingThreshold, 8);
  assert.equal(config.sources.pendingThreshold, 'project');
  await assert.rejects(setLearningConfig(f.directory, f.project, { maxRunMinutes: 0 }), { code: 'CONFIG' });
  assert.equal((await learningConfig(f.directory, await projectFor(f.directory, f.project))).values.maxRunMinutes, 60);
  const preview = await schedulePreview(f.directory, f.project, entry);
  assert.ok(preview.xml.includes('PT45M'));
  assert.ok(preview.command.includes(f.directory));
  assert.ok(!preview.command.includes('review --now'));
});

test('材料文件 ID 拒绝 Windows 设备名与备用数据流，不创建隐形材料', async () => {
  const f = await fixture(); await start(f);
  for (const id of ['NUL', 'CON', 'item:stream', 'a'.repeat(129)]) await assert.rejects(observe(f, 1, { id }), { code: 'INPUT' });
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
});
test('空队列零模型调用；单批限额、每日额度和未消费材料保留', async () => {
  const f = await fixture(); await setLearningEnabled(f.directory, f.project, true);
  let calls = 0;
  assert.equal((await reviewOnce(f.directory, f.project, fakeOptions({ runner: async () => { calls++; } }))).status, 'not-due');
  await start(f);
  for (let i = 1; i <= 11; i++) await observe(f, i);
  await finish(f);
  const defaults = fakeOptions();
  const result = await reviewOnce(f.directory, f.project, fakeOptions({ runner: async (...args) => { calls++; return defaults.runner(...args); } }));
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.equal((await readEntries(await projectFor(f.directory, f.project))).length, 10);
  assert.equal((await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true }))).status, 'daily-limit');
});
test('超时占额度但不消费材料；次日完整结果才写知识', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: async () => ({ status: 'timeout', usage: null }) }));
  assert.equal(first.status, 'timeout');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.equal((await readEntries(await projectFor(f.directory, f.project))).length, 0);
  const second = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, now: new Date(Date.now() + 86400000) }));
  assert.equal(second.status, 'completed');
});
test('验证、事件独立性与日期共同决定成熟度，展示次数不起作用', () => {
  const one = { id: 'one', incidentId: 'same', kind: 'success', verified: true, createdAt: '2026-10-21T10:00:00Z' };
  assert.equal(maturityFor([one, { ...one, id: 'copy' }, { ...one, id: 'copy2' }], 'method', 'active'), 'verified');
  assert.equal(maturityFor([one, { ...one, incidentId: 'two' }, { ...one, incidentId: 'three', createdAt: '2026-10-22T10:00:00Z' }], 'method', 'active'), 'stable');
  assert.equal(maturityFor([{ ...one, kind: 'legacy' }], 'method', 'active'), 'unverified');
  assert.equal(maturityFor([one], 'method', 'disputed'), 'unverified');
  assert.equal(maturityFor([one, { ...one, incidentId: 'two', kind: 'method' }, { ...one, incidentId: 'three', kind: 'method', createdAt: '2026-10-22T10:00:00Z' }], 'method', 'active'), 'verified');
});
test('明确反例立即停止召回；只读业务期间不写知识；未相关经验不会因重要性被强塞', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  assert.equal((await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true }))).status, 'completed');
  assert.equal((await selectKnowledge(f.directory, f.project, { text: '登录超时', paths: ['src/login.mjs'] })).selected.length, 1);
  assert.equal((await selectKnowledge(f.directory, f.project, { text: '页面配色', paths: ['src/theme.css'] })).selected.length, 0);
  f.turnId = 'new-turn'; f.taskId = 'task-2';
  await event(f, 'UserPromptSubmit'); await start(f, { mode: 'read-only', allowedPaths: [] });
  await observe(f, 2, { kind: 'correction', explicit: true, verified: false, knowledgeId: 'K-o1', summary: '用户指出这个登录建议不适用' });
  assert.equal((await selectKnowledge(f.directory, f.project, { text: '登录超时', paths: ['src/login.mjs'] })).selected.length, 0);
  await assert.rejects(reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true })), { code: 'BUSY' });
});
test('知识写后崩溃恢复不再调用模型且不重复消费', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const result = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, checkpoint(stage) { if (stage === 'written') { const e = new Error(); e.code = 'SIMULATED_CRASH'; throw e; } } }));
  assert.equal(result.status, 'recovery');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.equal((await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['src/login.mjs'] })).selected.length, 0);
  assert.equal((await recoverReview(f.directory, f.project, result.id)).status, 'completed');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
  assert.equal((await recoverReview(f.directory, f.project, result.id)).replayed, true);
});
test('等待证据的材料不每天重读，新材料可以唤醒；不同项目隔离', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f); await setLearningEnabled(f.directory, f.project, true);
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: async () => ({ status: 'completed', answer: { decisions: [{ observationIds: ['o1'], action: 'wait', reason: '缺少独立验证' }] } }) }));
  assert.equal(first.status, 'completed');
  assert.equal((await learningStatus(f.directory, f.project)).waiting, 1);
  const next = await reviewOnce(f.directory, f.project, fakeOptions({ now: new Date(Date.now() + 86400000) }));
  assert.equal(next.status, 'not-due');
  f.turnId = 'turn-next'; f.taskId = 'task-next'; await event(f, 'UserPromptSubmit'); await start(f); await observe(f, 2);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 2);
  const other = await fixture();
  assert.equal((await learningStatus(other.directory, other.project)).pending, 0);
});
test('迁移先备份旧状态；旧中断任务不再阻塞升级', async () => {
  const f = await fixture(); await start(f); await event(f, 'Interrupt');
  const file = path.join(f.directory, 'state.json');
  const old = JSON.parse(await readFile(file, 'utf8')); old.schemaVersion = 1;
  old.tasks[taskKey(f.projectId, f.taskId)].lifecycle = 'active';
  const raw = JSON.stringify(old); await writeFile(file, raw);
  assert.equal((await readState(f.directory)).tasks[taskKey(f.projectId, f.taskId)].lifecycle, 'suspended');
  await mutate(f.directory, async () => {});
  const names = await readdir(path.join(f.directory, 'migrations'));
  assert.equal(await readFile(path.join(f.directory, 'migrations', names[0]), 'utf8'), raw);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 2);
});
test('忽略普通工具事件，不重写全局状态；后台进程不递归触发 hooks', async () => {
  const f = await fixture();
  const file = path.join(f.directory, 'state.json'), before = await readFile(file, 'utf8');
  assert.deepEqual(await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }), {});
  assert.equal(await readFile(file, 'utf8'), before);
  const old = process.env.WORKFLOW_REVIEW; process.env.WORKFLOW_REVIEW = '1';
  try { assert.deepEqual(await event(f, 'UserPromptSubmit'), {}); }
  finally { if (old === undefined) delete process.env.WORKFLOW_REVIEW; else process.env.WORKFLOW_REVIEW = old; }
});

test('推翻结论重置成熟度；重要性可手动提高，后台有反例才能降低且仅通知一次', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  await setLearningConfig(f.directory, f.project, { maxRunsPerDay: 3 });
  await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true }));
  let existing = (await readEntries(await projectFor(f.directory, f.project)))[0];
  assert.equal(existing.maturity, 'verified');
  await reviseKnowledge(f.directory, f.project, { id: existing.id, baseline: existing.fingerprint, importance: 'critical', reason: '用户要求优先考虑' });
  f.turnId = 'turn-correct'; f.taskId = 'task-correct'; await event(f, 'UserPromptSubmit'); await start(f);
  await feedback(f.directory, { ...await identity(f), knowledgeId: existing.id, outcome: 'adopted', id: 'used-once' });
  await observe(f, 2, { knowledgeId: existing.id, kind: 'correction', verified: false, explicit: true, summary: '旧结论被推翻，应先取消请求再重试' });
  await finish(f);
  const unchanged = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true }));
  assert.equal(unchanged.status, 'failed');
  assert.equal(unchanged.reason, 'EVIDENCE');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  const defaults = fakeOptions();
  const result = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: async (...args) => {
    const response = await defaults.runner(...args);
    Object.assign(response.answer.decisions[0], { summary: '先取消登录请求再重试', importance: 'normal' });
    return response;
  } }));
  assert.equal(result.status, 'completed');
  existing = (await readEntries(await projectFor(f.directory, f.project)))[0];
  assert.equal(existing.maturity, 'unverified');
  assert.equal(existing.generation, 2);
  assert.equal(existing.importance, 'normal');
  assert.equal(existing.evidence.length, 2);
  const state = await readState(f.directory), project = state.projects[f.projectId];
  assert.equal((await projectContext(state, { project }, 'lead', null, { incremental: true })).notices.length, 1);
  assert.equal((await projectContext(state, { project }, 'lead', null, { incremental: true })).notices.length, 0);
});

test('无效结果保留整批材料；正在运行时全局锁阻止第二次模型调用', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f); await setLearningEnabled(f.directory, f.project, true);
  let release, signal;
  const started = new Promise(resolve => { signal = resolve; });
  const first = reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: async () => {
    signal(); await new Promise(resolve => { release = resolve; });
    return { status: 'completed', answer: { decisions: [] } };
  } }));
  await started;
  await assert.rejects(reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true })), { code: 'LOCKED' });
  release();
  assert.equal((await first).status, 'failed');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.equal((await readEntries(await projectFor(f.directory, f.project))).length, 0);
});

test('Windows 调度预览和模拟注册使用固定路径，禁用后检查不调用模型', async () => {
  const f = await fixture();
  // 接入时 Lead 应被提示补做后台学习启用与调度注册；用户作出决定后不再提示。
  const { getContext } = await import('../src/context.mjs');
  assert.match((await getContext(f.directory, f.project, 'lead', f.sessionId)).instruction, /learning schedule install/);
  assert.doesNotMatch((await getContext(f.directory, f.project, 'worker', f.sessionId)).instruction, /learning schedule install/);
  await setLearningEnabled(f.directory, f.project, true);
  assert.doesNotMatch((await getContext(f.directory, f.project, 'lead', f.sessionId)).instruction, /learning schedule install/);
  const preview = await schedulePreview(f.directory, f.project, entry);
  assert.match(preview.xml, /<StartBoundary>[^<]+Z<\/StartBoundary>/);
  // 计划任务若直接起控制台程序，默认终端会先弹出窗口并抢焦点。
  assert.match(preview.xml, /<Command>conhost\.exe<\/Command><Arguments>--headless &quot;[^<]*node[^<]*&quot; /i);
  assert.ok(!preview.xml.includes('powershell'));
  // 不带 UserId 的登录触发器需要管理员权限才能注册。
  if (process.env.USERNAME) assert.match(preview.xml, /<LogonTrigger><Enabled>true<\/Enabled><UserId>[^<]+<\/UserId><\/LogonTrigger>/);
  assert.ok(preview.command.includes('--state-dir'));
  const calls = [];
  const execute = async (file, args) => { calls.push(args); return { code: args.includes('/Query') ? 1 : 0 }; };
  if (process.platform === 'win32') {
    assert.equal((await installSchedule(f.directory, f.project, entry, execute)).status, 'registered');
    assert.equal((await removeSchedule(f.directory, f.project, execute)).status, 'removed');
    assert.equal(calls.length, 3);
  }
  await setLearningEnabled(f.directory, f.project, false);
  assert.doesNotMatch((await getContext(f.directory, f.project, 'lead', f.sessionId)).instruction, /learning schedule install/);
  assert.equal((await tick(f.directory, f.project, { runner: () => assert.fail('不应调用') })).status, 'disabled');
});

test('新增 CLI 配置和状态入口可往返；检查和预览不启用模型或系统任务', async () => {
  const f = await fixture();
  const args = ['--state-dir', f.directory, '--root', f.project];
  const configured = cli(['learning', 'config', 'set', ...args, '--base64', Buffer.from(JSON.stringify({ pendingThreshold: 9, maxRunMinutes: 45, checkIntervalMinutes: 20 })).toString('base64')]);
  assert.equal(configured.status, 0, configured.stdout);
  const status = cli(['learning', 'status', ...args]);
  assert.equal(status.status, 0, status.stdout);
  assert.equal(JSON.parse(status.stdout).config.maxRunMinutes, 45);
  assert.equal(JSON.parse(status.stdout).enabled, false);
  assert.equal(cli(['learning', 'schedule', 'preview', ...args]).status, 0);
  assert.equal(cli(['knowledge', 'explain', ...args, '--query', '登录']).status, 0);
});
