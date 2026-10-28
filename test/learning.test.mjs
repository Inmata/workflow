import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { capture, feedback, maturityFor, putItem, readEntries, readItems, renderEntry, reviseKnowledge, selectKnowledge } from '../src/learning.mjs';
import { projectContext } from '../src/context.mjs';
import { learningConfig, setLearningConfig, setLearningEnabled, projectFor } from '../src/learning-config.mjs';
import { dueReason, learningStatus, recoverReview, resolveReview, reviewOnce } from '../src/review.mjs';
import { preflight, runProcess } from '../src/runner.mjs';
import { schedulePreview, installSchedule, removeSchedule, tick } from '../src/scheduler.mjs';
import { readState, mutate, withLock } from '../src/store.mjs';
import { applyKnowledge, inspectKnowledge, createPending } from '../src/knowledge.mjs';
import { taskKey } from '../src/protocol.mjs';
import { event, fixture, identity, start, emit, deliver, entry, cli, KNOWLEDGE_TEST_HOOKS } from './helpers.mjs';

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
});

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
test('P11 复用已解析项目时仍随知识内容变化重新解析', async () => {
  const f = await fixture();
  const folder = path.join(f.project, '.workflow', 'knowledge');
  await mkdir(folder, { recursive: true });
  const value = {
    schemaVersion: 1, id: 'K-reuse', status: 'active', type: 'method', maturity: 'verified', importance: 'normal',
    title: '检索缓存验证', summary: 'alpha 检索词', conditions: '通用', evidence: [{ kind: 'success', verified: true, incidentId: 'incident-reuse', summary: '合成证据' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const file = path.join(folder, 'K-reuse.md');
  await writeFile(file, renderEntry(value));
  const project = await projectFor(f.directory, f.project);
  // 入口复用本回合已解析的项目记录，仍必须读到最新内容。
  assert.equal((await selectKnowledge(f.directory, f.project, { text: 'alpha', paths: [] }, { project })).selected.length, 1);
  await writeFile(file, renderEntry({ ...value, summary: 'beta 检索词，内容更长以改变大小', conditions: '通用条件也换了' }));
  assert.deepEqual((await selectKnowledge(f.directory, f.project, { text: 'beta', paths: [] }, { project })).selected.map(item => item.id), ['K-reuse']);
  assert.equal((await selectKnowledge(f.directory, f.project, { text: 'alpha', paths: [] }, { project })).selected.length, 0);
});
test('P11 知识目录链为链接时不读取外部条目', async () => {
  const f = await fixture();
  const outside = path.join(f.area, 'outside-knowledge');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'K-out.md'), renderEntry({
    schemaVersion: 1, id: 'K-out', status: 'active', type: 'method', maturity: 'verified', importance: 'normal',
    title: '外部条目', summary: '登录超时修复', conditions: '通用', evidence: [{ kind: 'success', verified: true, incidentId: 'incident-out', summary: '合成证据' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  await mkdir(path.join(f.project, '.workflow'), { recursive: true });
  await symlink(outside, path.join(f.project, '.workflow', 'knowledge'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await selectKnowledge(f.directory, f.project, { text: '登录超时', paths: [] });
  assert.equal(result.selected.length, 0);
  assert.equal(result.skippedTotal, 1);
  assert.equal(result.skipped[0].code, 'LINK');
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
test('P03 提交遇 BUSY 只延期；前台结束后由后续短检查接续，模型只调用一次', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const t0 = new Date('2026-10-28T10:00:00Z');
  let calls = 0;
  const defaults = fakeOptions();
  const first = await tick(f.directory, f.project, { now: t0, nowRequested: true, preflight: async () => ({ status: 'capabilities-verified' }), runner: async (...args) => {
    calls++;
    // 模型完成前前台启动：提交阶段应转为可自动延期的状态。
    f.turnId = 'turn-foreground'; f.taskId = 'task-foreground';
    await event(f, 'UserPromptSubmit');
    await start(f);
    return defaults.runner(...args);
  } });
  assert.equal(first.status, 'deferred');
  assert.equal(first.reason, 'BUSY');
  assert.equal(calls, 1);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.equal((await readEntries(await projectFor(f.directory, f.project))).length, 0);
  // 延期不消耗正常检查周期，只留下一次有界重试机会。
  let state = await readState(f.directory);
  assert.equal(state.projects[f.projectId].learning.lastCheckedAt, undefined);
  assert.ok(state.projects[f.projectId].learning.nextCheckAt);
  await finish(f);
  // 30 秒后的延期机会：只重试落盘，不再调用模型。
  const resumed = await tick(f.directory, f.project, { now: new Date(t0.getTime() + 30000), nowRequested: true, runner: () => assert.fail('延期接续不应调用模型') });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.resumed, true);
  assert.equal(calls, 1);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
  const runs = await readItems(f.directory, await projectFor(f.directory, f.project), 'runs');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].usage, { input_tokens: 100, output_tokens: 50 });
  // 连续检查不双写、不双消费，也不新增模型额度。
  const again = await tick(f.directory, f.project, { now: new Date(t0.getTime() + 20 * 60000), runner: () => assert.fail('不应再次调用模型') });
  assert.equal(again.status, 'daily-limit');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
  assert.equal((await readEntries(await projectFor(f.directory, f.project))).length, 1);
});

test('P03 真实内容冲突不覆盖用户编辑；作废后材料重新排队，新的模型调用按正常额度执行', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  await setLearningConfig(f.directory, f.project, { maxRunsPerDay: 3 });
  const t0 = new Date('2026-10-28T10:00:00Z');
  const userPath = path.join(f.project, '.workflow', 'knowledge', 'K-o1.md');
  const userContent = renderEntry(knowledgeEntry('K-o1', '用户手工编辑的登录经验', '保留用户自己的结论', ['src/login.mjs']));
  let calls = 0;
  const defaults = fakeOptions();
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ now: t0, nowRequested: true, runner: async (...args) => {
    calls++;
    await mkdir(path.dirname(userPath), { recursive: true });
    await writeFile(userPath, userContent);
    return defaults.runner(...args);
  } }));
  assert.equal(first.status, 'conflict');
  assert.equal(calls, 1);
  assert.equal(await readFile(userPath, 'utf8'), userContent);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  // 冲突不会反复原样自动提交，也不再调用模型。
  const retry = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: () => assert.fail('冲突不应再次调用模型') }));
  assert.equal(retry.status, 'conflict');
  // CLI 明确的作废出口：不消费 inbox、不改用户文件，并撤销本批隔离。
  const discarded = cli(['learning', 'resolve', '--root', f.project, '--state-dir', f.directory, '--run', first.id, '--discard']);
  assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
  assert.equal(JSON.parse(discarded.stdout).status, 'discarded');
  assert.equal(await readFile(userPath, 'utf8'), userContent);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.deepEqual((await readState(f.directory)).projects[f.projectId].learning.quarantine, {});
  await assert.rejects(recoverReview(f.directory, f.project, first.id), { code: 'RUN' });
  // 作废后重新排队，新模型调用正常发生并计入额度；人工编辑保持不变。
  const second = await reviewOnce(f.directory, f.project, fakeOptions({ now: t0, nowRequested: true, runner: async () => {
    calls++;
    return { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, answer: { decisions: [{ observationIds: ['o1'], action: 'wait', reason: '用户已手工处理，等待更多证据' }] } };
  } }));
  assert.equal(second.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(await readFile(userPath, 'utf8'), userContent);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
  assert.equal((await learningStatus(f.directory, f.project)).waiting, 1);
});

test('P03 冲突提案可显式保留，人工核对后手动恢复一次即可完成', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const t0 = new Date('2026-10-28T10:00:00Z');
  const userPath = path.join(f.project, '.workflow', 'knowledge', 'K-o1.md');
  const defaults = fakeOptions();
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ now: t0, nowRequested: true, runner: async (...args) => {
    await mkdir(path.dirname(userPath), { recursive: true });
    await writeFile(userPath, renderEntry(knowledgeEntry('K-o1', '用户版本', '用户先写入的结论', ['src/login.mjs'])));
    return defaults.runner(...args);
  } }));
  assert.equal(first.status, 'conflict');
  assert.equal((await resolveReview(f.directory, f.project, first.id, 'keep')).status, 'kept');
  const waiting = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: () => assert.fail('保留的冲突提案不应自动重试') }));
  assert.equal(waiting.status, 'recovery-required');
  // 人工把文件调整为提案内容后，手动恢复一次即可完成。
  const project = await projectFor(f.directory, f.project);
  const run = (await readItems(f.directory, project, 'runs')).find(r => r.id === first.id);
  await writeFile(path.join(f.project, run.proposal.changes[0].path), run.proposal.changes[0].content);
  const recovered = await recoverReview(f.directory, f.project, first.id);
  assert.equal(recovered.status, 'completed');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
  assert.deepEqual(await recoverReview(f.directory, f.project, first.id), { id: first.id, status: 'completed', replayed: true });
});

test('P03-r1 部分知识写入后冲突不得作废：保留隔离、提案与用户编辑，指引保留后人工恢复', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-old', '旧登录经验', '旧结论：直接重试', ['src/login.mjs']);
  await observe(f, 1, { knowledgeId: 'K-old', kind: 'correction', explicit: true, verified: false, summary: '用户指出旧结论不成立' });
  await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const folder = path.join(f.project, '.workflow', 'knowledge');
  const oldPath = path.join(folder, 'K-old.md');
  const oldContent = await readFile(oldPath, 'utf8');
  const answer = { decisions: [{
    observationIds: ['o1'], action: 'create', targetId: null, supersedes: 'K-old',
    title: '新的登录经验', summary: '新的结论：先取消再重试', conditions: '当前项目', type: 'method',
    importance: 'important', status: 'active', paths: ['src/login.mjs'], version: null,
    tags: ['登录'], reason: '用户明确指出旧结论不成立',
  }] };
  // 替代提案先写新知识、再写旧知识；让第二步失败，留下部分写入。
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true,
    runner: async () => ({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, answer }),
    checkpoint(stage, tx, result) { if (stage === 'prepared' && result.path.endsWith('K-old.md')) throw new Error('simulated write failure'); },
  }));
  assert.equal(first.status, 'recovery');
  assert.equal(await readFile(oldPath, 'utf8'), oldContent);
  assert.ok((await readFile(path.join(folder, 'K-o1.md'), 'utf8')).includes('新的登录经验'));
  // 用户编辑旧知识后恢复，冲突发生在再次提交前；此时新知识已经落盘。
  const userContent = renderEntry(knowledgeEntry('K-old', '用户手工版本', '用户自己的结论', ['src/login.mjs']));
  await writeFile(oldPath, userContent);
  await assert.rejects(recoverReview(f.directory, f.project, first.id), { code: 'CONFLICT' });
  await assert.rejects(resolveReview(f.directory, f.project, first.id, 'discard'), { code: 'CONFLICT' });
  const project = await projectFor(f.directory, f.project);
  assert.equal((await readItems(f.directory, project, 'runs')).find(r => r.id === first.id).status, 'conflict');
  assert.deepEqual((await readState(f.directory)).projects[f.projectId].learning.quarantine, {
    '.workflow/knowledge/K-o1.md': first.id,
    '.workflow/knowledge/K-old.md': first.id,
  });
  assert.equal(await readFile(oldPath, 'utf8'), userContent);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.ok((await readEntries(project)).some(e => e.id === 'K-o1'));
});

test('P03-r1 作废仅重排本运行材料：其余运行已消费的材料保持原状', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await observe(f, 2); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const inbox = path.join(f.directory, 'projects', f.projectId, 'inbox');
  const o1File = path.join(inbox, 'o1.json'), o2File = path.join(inbox, 'o2.json');
  let captured;
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: async () => {
    captured = JSON.parse(await readFile(o2File, 'utf8'));
    // 第一条材料更新成功后再让第二条读取失败，构造部分消费；本批只有 wait/dismiss，没有知识写入。
    await writeFile(o2File, 'not-json');
    return { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, answer: { decisions: [
      { observationIds: ['o1'], action: 'dismiss', reason: '重复材料' },
      { observationIds: ['o2'], action: 'dismiss', reason: '重复材料' },
    ] } };
  } }));
  assert.equal(first.status, 'recovery');
  const consumed = JSON.parse(await readFile(o1File, 'utf8'));
  assert.equal(consumed.status, 'processed');
  assert.equal(consumed.runId, first.id);
  // 第二条材料已被其他运行消费，恢复时转为冲突；本批没有知识写入，允许作废。
  await writeFile(o2File, JSON.stringify({ ...captured, status: 'processed', runId: 'other-run', processedAt: new Date().toISOString() }, null, 2) + '\n');
  await assert.rejects(recoverReview(f.directory, f.project, first.id), { code: 'CONFLICT' });
  const discarded = await resolveReview(f.directory, f.project, first.id, 'discard');
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.restored, 1);
  const restored = JSON.parse(await readFile(o1File, 'utf8'));
  assert.equal(restored.status, 'pending');
  assert.equal(restored.runId, undefined);
  const other = JSON.parse(await readFile(o2File, 'utf8'));
  assert.equal(other.status, 'processed');
  assert.equal(other.runId, 'other-run');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.deepEqual((await readState(f.directory)).projects[f.projectId].learning.quarantine, {});
});

test('P03-r2 写入后用户再编辑已写入文件：偏离写入前快照即拒绝作废，隔离、提案与材料保持', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-old', '旧登录经验', '旧结论：直接重试', ['src/login.mjs']);
  await observe(f, 1, { knowledgeId: 'K-old', kind: 'correction', explicit: true, verified: false, summary: '用户指出旧结论不成立' });
  await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const folder = path.join(f.project, '.workflow', 'knowledge');
  const oldPath = path.join(folder, 'K-old.md'), newPath = path.join(folder, 'K-o1.md');
  const oldContent = await readFile(oldPath, 'utf8');
  const answer = { decisions: [{
    observationIds: ['o1'], action: 'create', targetId: null, supersedes: 'K-old',
    title: '新的登录经验', summary: '新的结论：先取消再重试', conditions: '当前项目', type: 'method',
    importance: 'important', status: 'active', paths: ['src/login.mjs'], version: null,
    tags: ['登录'], reason: '用户明确指出旧结论不成立',
  }] };
  // 替代提案先写新知识、再写旧知识；让第二步失败，留下部分写入。
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true,
    runner: async () => ({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, answer }),
    checkpoint(stage, tx, result) { if (stage === 'prepared' && result.path.endsWith('K-old.md')) throw new Error('simulated write failure'); },
  }));
  assert.equal(first.status, 'recovery');
  assert.ok((await readFile(newPath, 'utf8')).includes('新的登录经验'));
  // 用户在部分写入后再次编辑已经落盘的正文：当前指纹既不是写入前快照，也不是提案正文。
  const userContent = renderEntry(knowledgeEntry('K-o1', '用户再次编辑', '用户自己的新结论', ['src/login.mjs']));
  await writeFile(newPath, userContent);
  await assert.rejects(recoverReview(f.directory, f.project, first.id), { code: 'CONFLICT' });
  await assert.rejects(resolveReview(f.directory, f.project, first.id, 'discard'), { code: 'CONFLICT' });
  const project = await projectFor(f.directory, f.project);
  const run = (await readItems(f.directory, project, 'runs')).find(r => r.id === first.id);
  assert.equal(run.status, 'conflict');
  assert.equal(run.proposal.changes.length, 2);
  assert.equal(await readFile(newPath, 'utf8'), userContent);
  assert.equal(await readFile(oldPath, 'utf8'), oldContent);
  assert.deepEqual((await readState(f.directory)).projects[f.projectId].learning.quarantine, {
    '.workflow/knowledge/K-o1.md': first.id,
    '.workflow/knowledge/K-old.md': first.id,
  });
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
});

test('P03-r2 未写入的新建文件不阻止作废；文件还原到写入前快照后作废并关闭待办', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-old', '旧登录经验', '旧结论：直接重试', ['src/login.mjs']);
  await observe(f, 1, { knowledgeId: 'K-old', kind: 'correction', explicit: true, verified: false, summary: '用户指出旧结论不成立' });
  await observe(f, 2);
  await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const folder = path.join(f.project, '.workflow', 'knowledge');
  const oldPath = path.join(folder, 'K-old.md'), newPath = path.join(folder, 'K-o2.md');
  const oldContent = await readFile(oldPath, 'utf8');
  const revise = { observationIds: ['o1'], action: 'revise', targetId: 'K-old', supersedes: null,
    title: '旧登录经验', summary: '修订后的结论：先取消再重试', conditions: '当前项目', type: 'method',
    importance: 'normal', status: 'active', paths: ['src/login.mjs'], version: null,
    tags: ['经验'], reason: '用户明确指出旧结论不成立' };
  const create = { observationIds: ['o2'], action: 'create', targetId: null, supersedes: null,
    title: '新的登录经验', summary: '另一条验证结论', conditions: '登录接口', type: 'method',
    importance: 'normal', status: 'active', paths: ['src/login.mjs'], version: null,
    tags: ['登录'], reason: '根据本批验证结果整理' };
  // 先写入已存在的旧知识，再让新建文件失败；新建文件始终未落盘。
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true,
    runner: async () => ({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, answer: { decisions: [revise, create] } }),
    checkpoint(stage, tx, result) { if (stage === 'prepared' && result.path.endsWith('K-o2.md')) throw new Error('simulated write failure'); },
  }));
  assert.equal(first.status, 'recovery');
  assert.notEqual(await readFile(oldPath, 'utf8'), oldContent);
  await assert.rejects(readFile(newPath), { code: 'ENOENT' });
  // 用户编辑已写入的旧知识制造冲突，再把文件还原到写入前快照。
  await writeFile(oldPath, renderEntry(knowledgeEntry('K-old', '用户版本', '用户自己的结论', ['src/login.mjs'])));
  await assert.rejects(recoverReview(f.directory, f.project, first.id), { code: 'CONFLICT' });
  await writeFile(oldPath, oldContent);
  const discarded = await resolveReview(f.directory, f.project, first.id, 'discard');
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.restored, 0);
  assert.equal(await readFile(oldPath, 'utf8'), oldContent);
  await assert.rejects(readFile(newPath), { code: 'ENOENT' });
  assert.equal((await learningStatus(f.directory, f.project)).pending, 2);
  assert.deepEqual((await readState(f.directory)).projects[f.projectId].learning.quarantine, {});
  const state = await readState(f.directory);
  const knowledgePending = Object.values(state.pending).filter(p => p.taskId === first.id && p.kind === 'knowledge-pending');
  assert.equal(knowledgePending.length, 1);
  assert.equal(knowledgePending[0].status, 'closed');
});


test('P03 跨项目锁争用只短延期，不额外等一个正常检查周期', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const t0 = new Date('2026-10-28T10:00:00Z');
  let release, acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = withLock(f.directory, 'background-review', async () => { acquired(); await gate; });
  await ready;
  const first = await tick(f.directory, f.project, { now: t0, nowRequested: true, runner: () => assert.fail('锁被占用时不应调用模型') });
  assert.equal(first.status, 'deferred');
  assert.equal(first.reason, 'LOCKED');
  let state = await readState(f.directory);
  assert.equal(state.projects[f.projectId].learning.lastCheckedAt, undefined);
  assert.ok(state.projects[f.projectId].learning.nextCheckAt);
  release(); await holding;
  // 30 秒后的有界机会即可执行，不必等到 15 分钟检查周期。
  const second = await tick(f.directory, f.project, { now: new Date(t0.getTime() + 30000), nowRequested: true, preflight: async () => ({ status: 'capabilities-verified' }), runner: fakeOptions().runner });
  assert.equal(second.status, 'completed');
  state = await readState(f.directory);
  assert.ok(state.projects[f.projectId].learning.lastCheckedAt);
  assert.equal(state.projects[f.projectId].learning.nextCheckAt, undefined);
});

test('P03 损坏或未知的未完成运行保守保留，不自动改成成功或失败', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const project = await projectFor(f.directory, f.project);
  await putItem(f.directory, project, 'runs', { id: 'review-committing', day: '2026-10-28', status: 'committing', reason: 'unknown-transaction', usage: null });
  let calls = 0;
  const first = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: () => { calls++; } }));
  assert.equal(first.status, 'recovery-required');
  assert.equal(calls, 0);
  let run = (await readItems(f.directory, project, 'runs')).find(r => r.id === 'review-committing');
  assert.equal(run.status, 'committing');
  assert.equal(run.reason, 'unknown-transaction');
  await putItem(f.directory, project, 'runs', { id: 'review-mystery', day: '2026-10-28', status: 'mystery', reason: null, usage: null, proposal: { changes: [], outcomes: [] }, batch: [], previous: [] });
  const second = await reviewOnce(f.directory, f.project, fakeOptions({ nowRequested: true, runner: () => { calls++; } }));
  assert.equal(second.status, 'recovery-required');
  assert.equal(calls, 0);
  run = (await readItems(f.directory, project, 'runs')).find(r => r.id === 'review-mystery');
  assert.equal(run.status, 'mystery');
});

test('P03 写后崩溃的事务由后续检查按既有恢复语义接续，不重复调用模型或消费材料', async () => {
  const f = await fixture(); await start(f); await observe(f, 1); await finish(f);
  await setLearningEnabled(f.directory, f.project, true);
  const t0 = new Date('2026-10-28T10:00:00Z');
  let calls = 0;
  const defaults = fakeOptions();
  const crashed = await reviewOnce(f.directory, f.project, fakeOptions({ now: t0, nowRequested: true, runner: async (...args) => {
    calls++;
    return defaults.runner(...args);
  }, checkpoint(stage) {
    if (stage === 'written') { const error = new Error(); error.code = 'SIMULATED_CRASH'; throw error; }
  } }));
  assert.equal(crashed.status, 'recovery');
  assert.equal(calls, 1);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 1);
  assert.equal(Object.values((await readState(f.directory)).transactions).length, 1);
  // 下次检查按指纹复用已完成写入，不调用模型。
  const resumed = await tick(f.directory, f.project, { now: new Date(t0.getTime() + 60000), nowRequested: true, runner: () => assert.fail('恢复事务不应调用模型') });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.resumed, true);
  assert.equal(calls, 1);
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
  assert.equal((await readEntries(await projectFor(f.directory, f.project))).length, 1);
  assert.ok(Object.values((await readState(f.directory)).transactions).some(tx => tx.status === 'applied'));
  // 连续检查不双写、不双消费。
  const again = await tick(f.directory, f.project, { now: new Date(t0.getTime() + 20 * 60000), runner: () => assert.fail('不应再次调用模型') });
  assert.equal(again.status, 'daily-limit');
  assert.equal((await learningStatus(f.directory, f.project)).pending, 0);
  assert.equal((await readEntries(await projectFor(f.directory, f.project))).length, 1);
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
  assert.match((await getContext(f.directory, f.project, 'lead', f.sessionId)).instruction, /--enable-learning/);
  assert.doesNotMatch((await getContext(f.directory, f.project, 'worker', f.sessionId)).instruction, /--enable-learning/);
  await setLearningEnabled(f.directory, f.project, true);
  assert.doesNotMatch((await getContext(f.directory, f.project, 'lead', f.sessionId)).instruction, /--enable-learning/);
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
  assert.doesNotMatch((await getContext(f.directory, f.project, 'lead', f.sessionId)).instruction, /--enable-learning/);
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

function knowledgeEntry(id, title, summary, paths = []) {
  return {
    schemaVersion: 1, id, generation: 1, title, summary, conditions: '当前项目', type: 'method', importance: 'normal', status: 'active',
    scope: { paths, version: null }, tags: ['经验'],
    evidence: [{ id: 'e1', incidentId: 'i1', kind: 'success', verified: true, createdAt: '2026-10-21T10:00:00Z', generation: 1 }],
    history: [], supersedes: null, maturity: 'verified',
  };
}
async function putKnowledge(f, id, title, summary, paths = []) {
  const folder = path.join(f.project, '.workflow', 'knowledge');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, id + '.md'), renderEntry(knowledgeEntry(id, title, summary, paths)));
}
// 元数据 JSON 合法且正文与 renderEntry 完全一致，只破坏字段类型；模拟人工/旧版本写入的结构损坏。
async function putCorruptKnowledge(f, id, mutate) {
  const value = knowledgeEntry(id, '损坏经验', '字段类型损坏的正文');
  mutate(value);
  const folder = path.join(f.project, '.workflow', 'knowledge');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, id + '.md'), renderEntry(value));
}
const knowledgePath = id => '.workflow/knowledge/' + id + '.md';
function entrance(output) {
  const text = output.hookSpecificOutput?.additionalContext;
  assert.ok(text?.startsWith('workflow 入口：'), JSON.stringify(output));
  return { text, context: JSON.parse(text.slice('workflow 入口：'.length)) };
}

test('P02 坏知识条目只跳过自身：新回合与 signal 正常、有效条目仍召回，修复后恢复', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-good', '登录超时经验', '登录超时先取消请求', ['README.md']);
  await writeFile(path.join(f.project, '.workflow', 'knowledge', 'K-bad.md'), '<!-- workflow-knowledge\n{"id":"K-bad"}\n-->\n\n# 坏条目\n');
  f.turnId = 'turn-2';
  const { context } = entrance(await event(f, 'UserPromptSubmit'));
  assert.ok(context.knowledge.selected.some(item => item.id === 'K-good'), JSON.stringify(context.knowledge));
  assert.equal(context.knowledge.skippedTotal, 1);
  assert.match(context.instruction, /无法解析/);
  const session = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.turnId, 'turn-2');
  assert.ok(session.ticket);
  const signal = await emit(f, { action: 'phase', phase: 'executing' });
  assert.equal(signal.result.accepted, true);
  // 完整诊断留在显式查询里，自动入口只给总数。
  const diagnostic = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'], full: true });
  assert.equal(diagnostic.skipped[0].path, '.workflow/knowledge/K-bad.md');
  // 修复同一文件后自然重新解析，不需要清缓存。
  await putKnowledge(f, 'K-bad', '登录重试', '先取消请求再重试', ['README.md']);
  const repaired = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'] });
  assert.equal(repaired.skippedTotal, 0);
  assert.ok(repaired.selected.some(item => item.id === 'K-bad'));
});

test('P02-r1 元数据字段类型损坏只跳过自身：召回与入口继续，维护读取仍严格', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-good', '登录超时经验', '登录超时先取消请求', ['README.md']);
  await putCorruptKnowledge(f, 'K-badtags', value => { value.tags = 'explicit'; });
  await putCorruptKnowledge(f, 'K-badscope', value => { value.scope = { paths: 'src/login.mjs', version: null }; });
  await putCorruptKnowledge(f, 'K-badtitle', value => { value.title = 42; });
  await putCorruptKnowledge(f, 'K-badversion', value => { value.scope = { paths: [], version: 3 }; });
  const badIds = ['K-badtags', 'K-badscope', 'K-badtitle', 'K-badversion'];
  const result = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'], full: true });
  // 字段类型损坏不会再在 join/some/replace 处抛 TypeError 中断整次召回。
  assert.equal(result.unavailable, null, JSON.stringify(result));
  assert.ok(result.selected.some(item => item.id === 'K-good'), JSON.stringify(result));
  assert.equal(result.skippedTotal, badIds.length);
  for (const id of badIds) assert.ok(result.skipped.some(item => item.path === knowledgePath(id)), id);
  f.turnId = 'turn-2';
  const { context } = entrance(await event(f, 'UserPromptSubmit'));
  assert.ok(context.knowledge.selected.some(item => item.id === 'K-good'), JSON.stringify(context.knowledge));
  assert.equal(context.knowledge.skippedTotal, badIds.length);
  assert.match(context.instruction, /无法解析/);
  // 维护/写入路径仍严格拒绝：跳过不等于可写授权。
  await assert.rejects(readEntries(await projectFor(f.directory, f.project)), { code: 'KNOWLEDGE' });
  // 修复后签名变化，缓存失效并重新解析；剩余损坏条目继续单独跳过。
  await putKnowledge(f, 'K-badtags', '登录重试', '先取消请求再重试', ['README.md']);
  const repaired = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'], full: true });
  assert.equal(repaired.skippedTotal, badIds.length - 1);
  assert.ok(repaired.selected.some(item => item.id === 'K-badtags'), JSON.stringify(repaired));
});

test('P02-r1 单文件读取故障不写入失败缓存：size 与 mtimeMs 不变也能在恢复后召回', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-good', '登录超时经验', '登录超时先取消请求', ['README.md']);
  await putKnowledge(f, 'K-locked', '登录重试经验', '先取消请求再重试', ['README.md']);
  const locked = path.join(f.project, '.workflow', 'knowledge', 'K-locked.md');
  const before = await stat(locked);
  // 模拟权限/占用导致的瞬时 readFile 失败；不修改文件内容、大小与时间戳。
  globalThis[KNOWLEDGE_TEST_HOOKS] = { beforeRead: ({ relative }) => {
    if (relative !== knowledgePath('K-locked')) return;
    const error = new Error('EBUSY: resource busy or locked, open ' + locked);
    error.code = 'EBUSY';
    throw error;
  } };
  let failed;
  try { failed = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'], full: true }); }
  finally { delete globalThis[KNOWLEDGE_TEST_HOOKS]; }
  assert.ok(failed.selected.some(item => item.id === 'K-good'), JSON.stringify(failed));
  assert.ok(failed.skipped.some(item => item.path === knowledgePath('K-locked') && item.code === 'EBUSY'), JSON.stringify(failed.skipped));
  assert.equal(failed.skippedTotal, 1);
  // 读取故障不是确定性解析结果，本次不得固化索引，否则恢复后同签名会永久命中失败缓存。
  await assert.rejects(readFile(path.join(f.directory, 'projects', f.projectId, 'knowledge-index.json')), { code: 'ENOENT' });
  const after = await stat(locked);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const recovered = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'], full: true });
  assert.equal(recovered.skippedTotal, 0, JSON.stringify(recovered.skipped));
  assert.ok(recovered.selected.some(item => item.id === 'K-locked'), JSON.stringify(recovered));
});

test('P02 知识目录缺失与读取故障提示可区分，入口身份仍然保存', async () => {
  const missing = await fixture();
  await setLearningEnabled(missing.directory, missing.project, true);
  await start(missing);
  missing.turnId = 'turn-2';
  const absent = entrance(await event(missing, 'UserPromptSubmit')).context;
  assert.equal(absent.knowledge.unavailable.kind, 'missing');
  assert.match(absent.instruction, /知识目录不存在/);
  const io = await fixture();
  await mkdir(path.join(io.project, '.workflow'), { recursive: true });
  await writeFile(path.join(io.project, '.workflow', 'knowledge'), '占用目录名');
  await start(io);
  io.turnId = 'turn-2';
  const failed = entrance(await event(io, 'UserPromptSubmit')).context;
  assert.equal(failed.knowledge.unavailable.kind, 'io');
  assert.ok(failed.knowledge.unavailable.code);
  assert.match(failed.instruction, /可选知识读取失败/);
});

test('P02 大量未匹配知识不撑大自动入口；排除清单受预算，显式查询给完整诊断', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-hit', '登录超时经验', '登录超时先取消请求', ['README.md']);
  for (let i = 0; i < 5; i++) await putKnowledge(f, `K-other${i}`, `无关经验 ${i}`, `页面配色与间距 ${i}`);
  f.turnId = 'turn-2';
  const small = entrance(await event(f, 'UserPromptSubmit'));
  assert.equal(small.context.knowledge.excludedTotal, 5);
  for (let i = 5; i < 60; i++) await putKnowledge(f, `K-other${i}`, `无关经验 ${i}`, `页面配色与间距 ${i}`);
  f.turnId = 'turn-3';
  const big = entrance(await event(f, 'UserPromptSubmit'));
  assert.equal(big.context.knowledge.excludedTotal, 60);
  assert.equal(big.context.knowledge.excluded, undefined);
  // 排除条目只体现在总数，不按条数线性进入入口正文。
  assert.ok(big.text.length - small.text.length < 300, `${small.text.length} -> ${big.text.length}`);
  const limited = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'] });
  assert.ok(limited.excluded.length <= 10);
  assert.equal(limited.excludedOmitted, 60 - limited.excluded.length);
  const full = await selectKnowledge(f.directory, f.project, { text: '登录', paths: ['README.md'], full: true });
  assert.equal(full.excluded.length, 60);
});

test('P02 对齐读取失败单独降级，不阻断新回合保存', async () => {
  const f = await fixture(); await start(f);
  await mutate(f.directory, async state => {
    state.projects[f.projectId].alignment = { docPath: '.', files: [], directories: [] };
  });
  f.turnId = 'turn-2';
  const { context } = entrance(await event(f, 'UserPromptSubmit'));
  assert.ok(context.alignment.error.code);
  assert.match(context.instruction, /对齐状态未读取/);
  const session = Object.values((await readState(f.directory)).sessions).find(item => item.sessionId === f.sessionId);
  assert.equal(session.turnId, 'turn-2');
});
