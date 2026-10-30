import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readExtractionJobs, runExtractionJobs } from '../src/capture.mjs';
import { capture, readEntries, readItems, renderEntry, selectKnowledge } from '../src/learning.mjs';
import { setLearningConfig, setLearningEnabled, projectFor } from '../src/learning-config.mjs';
import { learningStatus, reviewOnce } from '../src/review.mjs';
import { event, fixture, identity, start, entry } from './helpers.mjs';

// F16/F18 只使用人工重写的最小脱敏 transcript，不读取任何真实聊天记录。
const transcriptLine = (sessionId, role, text) => JSON.stringify({ type: role, sessionId, message: { role, content: [{ type: 'text', text }] } });
async function writeTranscript(f, lines, name = 'transcript.jsonl') {
  const file = path.join(f.area, name);
  await writeFile(file, lines.join('\n') + '\n');
  return file;
}
async function taskEnd(f, transcriptPath, signalId = 'signal-' + crypto.randomUUID(), base) {
  const payload = base || { ...await identity(f), taskId: f.taskId, signalId, action: 'task-end' };
  const output = await event(f, 'PostToolUse', {
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
    tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` },
    tool_response: { output: JSON.stringify({ workflow_signal: payload }) },
  });
  const text = output.hookSpecificOutput?.additionalContext;
  assert.ok(text?.startsWith('workflow 回执：'), JSON.stringify(output));
  return { payload, result: JSON.parse(text.slice('workflow 回执：'.length)) };
}
function extract(f, runner) {
  return runExtractionJobs(f.directory, f.project, { preflight: async () => ({ status: 'capabilities-verified' }), runner });
}
const candidateFor = (index, extra = {}) => ({
  kind: 'correction', summary: '用户纠正了等待方式', conditions: '子智能体等待', evidence: ['transcript:' + index],
  paths: ['docs/说明.md'], explicit: true, verified: false, incident: 'wait', ...extra,
});
const promptData = prompt => JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
const jobsOf = async f => (await readExtractionJobs(f.directory, await projectFor(f.directory, f.project))).jobs;
const inboxOf = async f => readItems(f.directory, await projectFor(f.directory, f.project), 'inbox');
const knowledgeOf = async f => readEntries(await projectFor(f.directory, f.project));
async function observe(f, id, extra = {}) {
  return capture(f.directory, { ...await identity(f), observation: { id: 'o' + id, incidentId: 'incident-' + id, kind: 'success', summary: '材料 ' + id, conditions: '登录', evidence: ['test:' + id], paths: ['src/login.mjs'], verified: true, ...extra } });
}
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

test('F16 已接受 task-end 登记幂等提取作业：早期纠正形成带证据候选，重放不新增', async () => {
  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  const transcript = await writeTranscript(f, [
    transcriptLine(f.sessionId, 'user', '不要一直等五分钟，先检查日志再说'),
    transcriptLine(f.sessionId, 'assistant', '我检查了日志，问题在端口占用'),
  ]);
  const ended = await taskEnd(f, transcript);
  assert.equal(ended.result.accepted, true);
  assert.equal(ended.result.extraction.status, 'registered');
  let calls = 0, seenPrompt = '';
  const result = await extract(f, async (config, prompt) => {
    calls++; seenPrompt = prompt;
    const data = promptData(prompt);
    const user = data.messages.find(item => item.role === 'user');
    return { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, answer: { candidates: [candidateFor(user.index)] } };
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.candidates, 1);
  assert.equal(calls, 1);
  assert.match(seenPrompt, /检查日志/);
  const items = await inboxOf(f);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].origin, 'auto-extract');
  assert.ok(items[0].jobId);
  assert.deepEqual(items[0].evidence, ['transcript:1']);
  assert.deepEqual(items[0].paths, ['docs/说明.md']);
  // 候选只进 inbox，不直接形成正式知识。
  assert.equal((await knowledgeOf(f)).length, 0);
  const jobs = await jobsOf(f);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed');
  assert.equal(jobs[0].candidates, 1);
  assert.deepEqual(jobs[0].usage, { input_tokens: 10, output_tokens: 5 });
  // 已完成的作业不会再次调用模型，也不会重复写材料。
  assert.equal((await extract(f, async () => { calls++; })).status, 'idle');
  assert.equal(calls, 1);
  assert.equal((await inboxOf(f)).length, 1);
  // 同 task-end 重放、Stop 与普通 Hook 都不重复登记。
  const replayed = await taskEnd(f, transcript, ended.payload.signalId, ended.payload);
  assert.equal(replayed.result.replayed, true);
  assert.equal(replayed.result.extraction.status, 'exists');
  await event(f, 'Stop');
  await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } });
  assert.equal((await jobsOf(f)).length, 1);
});

test('F16 零候选允许；助手自我总结与工具日志不能凭模型输出变成经验', async () => {
  const empty = await fixture(); await start(empty); await setLearningEnabled(empty.directory, empty.project, true);
  const emptyTranscript = await writeTranscript(empty, [transcriptLine(empty.sessionId, 'user', '今天先这样')]);
  await taskEnd(empty, emptyTranscript);
  const zero = await extract(empty, async () => ({ status: 'completed', answer: { candidates: [] } }));
  assert.equal(zero.status, 'completed');
  assert.equal(zero.candidates, 0);
  assert.equal((await inboxOf(empty)).length, 0);

  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  const transcript = await writeTranscript(f, [
    transcriptLine(f.sessionId, 'assistant', '我把这次会话总结成一条经验：应该先检查日志'),
    transcriptLine(f.sessionId, 'assistant', '工具输出：command failed with code 1'),
  ]);
  await taskEnd(f, transcript);
  const result = await extract(f, async (config, prompt) => {
    const data = promptData(prompt);
    const assistant = data.messages.find(item => item.role === 'assistant');
    return { status: 'completed', answer: { candidates: [candidateFor(assistant.index), candidateFor(assistant.index, { evidence: ['assistant:1'] })] } };
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.candidates, 0);
  assert.equal(result.rejected, 2);
  assert.equal((await inboxOf(f)).length, 0);
  assert.equal((await knowledgeOf(f)).length, 0);
});

test('F16 禁用、禁止学习或无 transcript 时零模型调用，任务结束不回滚', async () => {
  const disabled = await fixture(); await start(disabled);
  const disabledTranscript = await writeTranscript(disabled, [transcriptLine(disabled.sessionId, 'user', '先这样')]);
  const ended = await taskEnd(disabled, disabledTranscript);
  assert.equal(ended.result.accepted, true);
  assert.equal(ended.result.extraction.status, 'skipped');
  assert.equal(ended.result.extraction.reason, 'learning-disabled');
  assert.equal((await jobsOf(disabled)).length, 0);
  let calls = 0;
  assert.equal((await extract(disabled, async () => { calls++; })).status, 'disabled');
  assert.equal(calls, 0);

  const forbidden = await fixture(); await setLearningEnabled(forbidden.directory, forbidden.project, true);
  await start(forbidden, { mode: 'write', allowedPaths: ['README.md'], learning: false });
  const forbiddenTranscript = await writeTranscript(forbidden, [transcriptLine(forbidden.sessionId, 'user', '先这样')]);
  const denied = await taskEnd(forbidden, forbiddenTranscript);
  assert.equal(denied.result.accepted, true);
  assert.equal(denied.result.extraction.reason, 'permission-denied');
  assert.equal((await jobsOf(forbidden)).length, 0);
  assert.equal((await extract(forbidden, async () => { calls++; })).status, 'idle');
  assert.equal(calls, 0);

  const noPath = await fixture(); await start(noPath); await setLearningEnabled(noPath.directory, noPath.project, true);
  const absent = await taskEnd(noPath);
  assert.equal(absent.result.accepted, true);
  assert.equal(absent.result.extraction.reason, 'no-transcript');
  assert.equal((await jobsOf(noPath)).length, 0);
  assert.equal((await extract(noPath, async () => { calls++; })).status, 'idle');
  assert.equal(calls, 0);
});

test('F16 读取失败、格式错误、身份不符、超时与无效输出都不阻塞 task-end、不产生正式知识', async () => {
  const missing = await fixture(); await start(missing); await setLearningEnabled(missing.directory, missing.project, true);
  const started = await taskEnd(missing, path.join(missing.area, 'not-there.jsonl'));
  assert.equal(started.result.accepted, true);
  assert.equal(started.result.extraction.status, 'skipped');
  const missingJob = (await jobsOf(missing))[0];
  assert.equal(missingJob.status, 'skipped');
  let calls = 0;
  assert.equal((await extract(missing, async () => { calls++; })).status, 'idle');
  assert.equal(calls, 0);

  const format = await fixture(); await start(format); await setLearningEnabled(format.directory, format.project, true);
  const bad = path.join(format.area, 'bad.jsonl');
  await writeFile(bad, 'not json\n');
  await taskEnd(format, bad);
  const formatRun = await extract(format, async () => { calls++; });
  assert.equal(formatRun.status, 'skipped');
  assert.equal(formatRun.reason, 'TRANSCRIPT_FORMAT');
  assert.equal(calls, 0);
  assert.equal((await knowledgeOf(format)).length, 0);

  const identityMismatch = await fixture(); await start(identityMismatch); await setLearningEnabled(identityMismatch.directory, identityMismatch.project, true);
  const foreign = await writeTranscript(identityMismatch, [transcriptLine('other-session', 'user', '别的会话')], 'foreign.jsonl');
  await taskEnd(identityMismatch, foreign);
  const identityRun = await extract(identityMismatch, async () => { calls++; });
  assert.equal(identityRun.status, 'skipped');
  assert.equal(identityRun.reason, 'TRANSCRIPT_IDENTITY');
  assert.equal(calls, 0);

  const timeout = await fixture(); await start(timeout); await setLearningEnabled(timeout.directory, timeout.project, true);
  const slow = await writeTranscript(timeout, [transcriptLine(timeout.sessionId, 'user', '先检查日志')], 'slow.jsonl');
  await taskEnd(timeout, slow);
  let timeouts = 0;
  const timingOut = async () => { timeouts++; return { status: 'timeout', usage: null }; };
  assert.equal((await extract(timeout, timingOut)).status, 'timeout');
  assert.equal((await extract(timeout, timingOut)).status, 'timeout');
  assert.equal((await extract(timeout, timingOut)).status, 'idle');
  assert.equal(timeouts, 2);
  assert.equal((await jobsOf(timeout))[0].attempts, 2);
  assert.equal((await inboxOf(timeout)).length, 0);

  const invalid = await fixture(); await start(invalid); await setLearningEnabled(invalid.directory, invalid.project, true);
  const valid = await writeTranscript(invalid, [transcriptLine(invalid.sessionId, 'user', '先检查日志')], 'valid.jsonl');
  await taskEnd(invalid, valid);
  const invalidRun = await extract(invalid, async () => ({ status: 'completed', answer: { nope: true } }));
  assert.equal(invalidRun.status, 'failed');
  assert.equal(invalidRun.reason, 'RESULT');
  assert.equal((await inboxOf(invalid)).length, 0);
  assert.equal((await knowledgeOf(invalid)).length, 0);
});

test('F16 输入预算剔除工具输出，只保留用户与助手的短文本', async () => {
  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  const huge = 'TOOL-OUTPUT-MARKER ' + 'x'.repeat(20000);
  const transcript = await writeTranscript(f, [
    JSON.stringify({ type: 'user', sessionId: f.sessionId, message: { role: 'user', content: [{ type: 'tool_result', content: huge }] } }),
    transcriptLine(f.sessionId, 'user', '不要反复重试，先看失败原因'),
    transcriptLine(f.sessionId, 'assistant', '明白，先看失败原因'),
  ]);
  await taskEnd(f, transcript);
  let promptText = '';
  await extract(f, async (config, prompt) => {
    promptText = prompt;
    const data = promptData(prompt);
    const user = data.messages.find(item => item.role === 'user');
    return { status: 'completed', answer: { candidates: [candidateFor(user.index)] } };
  });
  assert.ok(!promptText.includes('TOOL-OUTPUT-MARKER'));
  assert.ok(promptText.length < 30000);
});

test('F18 学习漏斗分开统计材料、运行、知识、反馈与提取作业，并保留归因范围', async () => {
  const f = await fixture(); await start(f);
  await putKnowledge(f, 'K-old', '旧等待经验', '等五分钟再继续', ['src/login.mjs']);
  await observe(f, 1);
  await observe(f, 2, { kind: 'correction', explicit: true, verified: false, knowledgeId: 'K-old', summary: '用户纠正等待方式' });
  await observe(f, 3, { kind: 'failure', verified: true, summary: '构建失败', conditions: '构建' });
  const { feedback } = await import('../src/learning.mjs');
  await feedback(f.directory, { ...await identity(f), knowledgeId: 'K-old', outcome: 'shown', id: 'shown-1' });
  await feedback(f.directory, { ...await identity(f), knowledgeId: 'K-old', outcome: 'adopted', id: 'adopted-1' });
  await setLearningEnabled(f.directory, f.project, true);
  await setLearningConfig(f.directory, f.project, { maxRunsPerDay: 3 });
  const transcript = await writeTranscript(f, [
    transcriptLine(f.sessionId, 'user', '不要一直等五分钟，先检查日志'),
    transcriptLine(f.sessionId, 'assistant', '我检查了日志'),
  ]);
  await taskEnd(f, transcript);
  const extracted = await extract(f, async (config, prompt) => {
    const data = promptData(prompt);
    const user = data.messages.find(item => item.role === 'user');
    return { status: 'completed', usage: { input_tokens: 20, output_tokens: 5 }, answer: { candidates: [candidateFor(user.index)] } };
  });
  assert.equal(extracted.candidates, 1);
  const auto = (await inboxOf(f)).find(item => item.origin === 'auto-extract');
  const decision = (observationIds, action, extra = {}) => ({
    observationIds, action, targetId: null, supersedes: null, title: '经验', summary: '结论', conditions: '当前项目',
    type: 'method', importance: 'normal', status: 'active', paths: ['src/login.mjs'], version: null, tags: [], reason: '整理材料', ...extra,
  });
  const reviewed = await reviewOnce(f.directory, f.project, {
    nowRequested: true, preflight: async () => ({ status: 'capabilities-verified' }),
    runner: async () => ({ status: 'completed', usage: { input_tokens: 30, output_tokens: 10 }, answer: { decisions: [
      decision(['o2'], 'revise', { targetId: 'K-old', title: '旧等待经验', summary: '先检查日志再决定等待', conditions: '当前项目', paths: ['src/login.mjs'] }),
      decision(['o1'], 'create', { paths: ['src/login.mjs'] }),
      decision(['o3'], 'create', { type: 'fact', paths: [] }),
      // 仅改变范围：不改结论，不需要反例，但必须创建独立知识，因此被 SCOPE 隔离。
      decision([auto.id], 'revise', { targetId: 'K-old', title: '旧等待经验', summary: '等五分钟再继续', conditions: '当前项目', paths: ['src/other.mjs'] }),
    ] } }),
  });
  assert.equal(reviewed.status, 'partial');
  assert.equal(reviewed.rejected.length, 1);
  assert.equal(reviewed.rejected[0].code, 'SCOPE');
  assert.deepEqual(reviewed.rejected[0].observationIds, [auto.id]);
  // select 查询不算 adopted。
  await selectKnowledge(f.directory, f.project, { text: '等待', paths: ['src/login.mjs'] });
  const status = await learningStatus(f.directory, f.project, new Date(), { sessionId: f.sessionId, taskId: f.taskId });
  assert.deepEqual(status.scope, { taskId: f.taskId, sessionId: f.sessionId, materials: 'filtered', runs: 'project', knowledge: 'project', capture: 'filtered', feedback: 'filtered' });
  assert.equal(status.materials.total, 4);
  assert.equal(status.materials.pending, 1);
  assert.equal(status.materials.processed, 3);
  assert.equal(status.materials.waiting, 0);
  assert.deepEqual(status.evidence, { success: 1, failure: 1, correction: 2 });
  assert.deepEqual({ shown: status.feedback.shown, adopted: status.feedback.adopted, total: status.feedback.total }, { shown: 1, adopted: 1, total: 2 });
  assert.equal(status.knowledge.total, 3);
  assert.equal(status.knowledge.created, 2);
  assert.equal(status.knowledge.revised, 1);
  assert.equal(status.runs.at(-1).status, 'partial');
  assert.equal(status.runs.at(-1).rejected[0].code, 'SCOPE');
  assert.deepEqual(status.runs.at(-1).rejected[0].observationIds, [auto.id]);
  assert.equal(status.capture.total, 1);
  assert.equal(status.capture.completed, 1);
  assert.equal(status.capture.todayStarted, 1);
  assert.deepEqual(status.capture.usage, { input_tokens: 20, output_tokens: 5 });
  assert.deepEqual(status.limits.capture, { todayStarted: 1, maxRunsPerDay: 1 });
  assert.ok(status.at);

  const quiet = await fixture();
  const empty = await learningStatus(quiet.directory, quiet.project);
  assert.equal(empty.feedback.note, '无记录');
  assert.equal(empty.feedback.shown, 0);
  assert.equal(empty.feedback.adopted, 0);
});
