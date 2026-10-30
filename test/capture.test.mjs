import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { readExtractionJobs, runExtractionJobs } from '../src/capture.mjs';
import { capture, feedback, putItem, readEntries, readItems, renderEntry, selectKnowledge } from '../src/learning.mjs';
import { setLearningConfig, setLearningEnabled, projectFor } from '../src/learning-config.mjs';
import { learningStatus, reviewOnce } from '../src/review.mjs';
import { readState } from '../src/store.mjs';
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
  assert.deepEqual(status.scope, { taskId: f.taskId, sessionId: f.sessionId, materials: 'filtered', runs: 'project', knowledge: 'project', capture: 'filtered', feedback: 'filtered', unattributed: 'task-level-or-unknown' });
  assert.deepEqual(status.unattributed, { scope: 'task-level-or-unknown', taskLevel: { materials: 0, capture: 0, feedback: 0 }, unknown: { materials: 0, capture: 0, feedback: 0 } });
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
  assert.deepEqual(status.limits.capture, { todayStarted: 1, maxRunsPerDay: 1, scope: 'project' });
  assert.ok(status.at);

  const quiet = await fixture();
  const empty = await learningStatus(quiet.directory, quiet.project);
  assert.equal(empty.feedback.note, '无记录');
  assert.equal(empty.feedback.shown, 0);
  assert.equal(empty.feedback.adopted, 0);
});

test('F16 transcript 缺少会话身份时整份跳过，Codex 必须有匹配的 session_meta', async () => {
  // Claude 记录逐条带 sessionId；缺失或他人的记录不能凭“没有识别到别的会话”被采用。
  const anonymous = await fixture(); await start(anonymous); await setLearningEnabled(anonymous.directory, anonymous.project, true);
  const anonymousPath = await writeTranscript(anonymous, [JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '先检查日志' }] } })], 'anonymous.jsonl');
  await taskEnd(anonymous, anonymousPath);
  let calls = 0;
  const unknown = async () => { calls++; return { status: 'completed', answer: { candidates: [] } }; };
  const anonymousRun = await extract(anonymous, unknown);
  assert.equal(anonymousRun.status, 'skipped');
  assert.equal(anonymousRun.reason, 'TRANSCRIPT_IDENTITY');
  assert.equal(calls, 0);

  // Codex 没有 session_meta 时无法建立正面身份，整份跳过。
  const noMeta = await fixture(); await start(noMeta); await setLearningEnabled(noMeta.directory, noMeta.project, true);
  const noMetaPath = await writeTranscript(noMeta, [JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '先检查日志' }] } })], 'codex-no-meta.jsonl');
  await taskEnd(noMeta, noMetaPath);
  const noMetaRun = await extract(noMeta, unknown);
  assert.equal(noMetaRun.status, 'skipped');
  assert.equal(noMetaRun.reason, 'TRANSCRIPT_IDENTITY');
  assert.equal(calls, 0);

  const foreign = await fixture(); await start(foreign); await setLearningEnabled(foreign.directory, foreign.project, true);
  const foreignPath = await writeTranscript(foreign, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'other-session' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '先检查日志' }] } }),
  ], 'codex-foreign.jsonl');
  await taskEnd(foreign, foreignPath);
  const foreignRun = await extract(foreign, unknown);
  assert.equal(foreignRun.status, 'skipped');
  assert.equal(foreignRun.reason, 'TRANSCRIPT_IDENTITY');
  assert.equal(calls, 0);

  // 匹配的 session_meta 才建立身份，候选仍只进 inbox。
  const matched = await fixture(); await start(matched); await setLearningEnabled(matched.directory, matched.project, true);
  const matchedPath = await writeTranscript(matched, [
    JSON.stringify({ type: 'session_meta', payload: { id: matched.sessionId } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '不要一直等五分钟，先检查日志' }] } }),
  ], 'codex-matched.jsonl');
  await taskEnd(matched, matchedPath);
  const matchedRun = await extract(matched, async () => ({ status: 'completed', answer: { candidates: [candidateFor(1)] } }));
  assert.equal(matchedRun.status, 'completed');
  assert.equal(matchedRun.candidates, 1);
  assert.equal((await inboxOf(matched)).length, 1);
});

test('F16 transcript 路径必须是绝对路径的普通文件', async () => {
  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  const ended = await taskEnd(f, 'transcript.jsonl');
  assert.equal(ended.result.accepted, true);
  assert.equal(ended.result.extraction.status, 'skipped');
  assert.equal(ended.result.extraction.reason, 'TRANSCRIPT_PATH');
  const jobs = await jobsOf(f);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'skipped');
  assert.equal(jobs[0].reason, 'TRANSCRIPT_PATH');
  let calls = 0;
  assert.equal((await extract(f, async () => { calls++; })).status, 'idle');
  assert.equal(calls, 0);
});

test('F16 transcript 真实路径与给定路径不一致时拒绝（目录链接）', async t => {
  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  const real = path.join(f.area, 'real');
  await mkdir(real);
  await writeFile(path.join(real, 'transcript.jsonl'), transcriptLine(f.sessionId, 'user', '先检查日志') + '\n');
  const linked = path.join(f.area, 'linked');
  try { await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('当前平台/账户无法创建目录链接'); return; }
  const ended = await taskEnd(f, path.join(linked, 'transcript.jsonl'));
  assert.equal(ended.result.accepted, true);
  assert.equal(ended.result.extraction.status, 'skipped');
  assert.equal(ended.result.extraction.reason, 'TRANSCRIPT_LINK');
  let calls = 0;
  assert.equal((await extract(f, async () => { calls++; })).status, 'idle');
  assert.equal(calls, 0);
});

test('F16 transcript 文件符号链接被拒绝', async t => {
  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  const real = path.join(f.area, 'real-transcript.jsonl');
  await writeFile(real, transcriptLine(f.sessionId, 'user', '先检查日志') + '\n');
  const link = path.join(f.area, 'link-transcript.jsonl');
  try { await symlink(real, link, 'file'); }
  catch { t.skip('当前 Windows 账户不能创建文件符号链接'); return; }
  const ended = await taskEnd(f, link);
  assert.equal(ended.result.accepted, true);
  assert.equal(ended.result.extraction.status, 'skipped');
  assert.equal(ended.result.extraction.reason, 'TRANSCRIPT_LINK');
  let calls = 0;
  assert.equal((await extract(f, async () => { calls++; })).status, 'idle');
  assert.equal(calls, 0);
});

test('F16 自动反例与人工采集共享反例与唤醒处理，knowledgeId 必须存在', async () => {
  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  await putKnowledge(f, 'K-old', '旧等待经验', '等五分钟再继续', ['src/login.mjs']);
  const project = await projectFor(f.directory, f.project);
  await putItem(f.directory, project, 'inbox', {
    id: 'wait-1', incidentId: 'incident-wait', kind: 'success', summary: '待唤醒材料', conditions: '子智能体等待',
    evidence: ['test:wait'], paths: [], knowledgeId: 'K-old', explicit: false, verified: true,
    createdAt: '2026-10-29T00:00:00.000Z', projectId: f.projectId, taskId: 'task-old', sessionId: 'session-old', status: 'waiting',
  });
  const transcript = await writeTranscript(f, [transcriptLine(f.sessionId, 'user', '不要一直等五分钟，先检查日志')]);
  await taskEnd(f, transcript);
  const result = await extract(f, async () => ({ status: 'completed', answer: { candidates: [
    candidateFor(1, { knowledgeId: 'K-old' }),
    candidateFor(1, { knowledgeId: 'K-missing', summary: '引用不存在的旧知识' }),
  ] } }));
  assert.equal(result.status, 'completed');
  assert.equal(result.candidates, 1);
  assert.equal(result.rejected, 1);
  const items = await inboxOf(f);
  const auto = items.find(item => item.origin === 'auto-extract');
  assert.ok(auto);
  assert.equal(auto.status, 'pending');
  assert.equal(items.some(item => item.knowledgeId === 'K-missing'), false);
  // 同知识或同条件的 waiting 材料被唤醒回 pending。
  const woken = items.find(item => item.id === 'wait-1');
  assert.equal(woken.status, 'pending');
  assert.equal(woken.wokenBy, auto.id);
  // 明确反例立即停止该旧知识的默认召回。
  const selected = await selectKnowledge(f.directory, f.project, { text: '等待', paths: ['src/login.mjs'] });
  assert.equal(selected.selected.length, 0);
  assert.ok(selected.excluded.some(item => item.id === 'K-old' && item.reason === '即时反例待处理'));
  const state = await readState(f.directory);
  assert.equal(state.projects[f.projectId].learning.disputes['K-old'].observationId, auto.id);
});

test('F18 会话过滤只计精确归属，任务级/未知归属单列，额度按项目累计', async () => {
  const f = await fixture(); await start(f); await setLearningEnabled(f.directory, f.project, true);
  await setLearningConfig(f.directory, f.project, { maxCaptureRunsPerDay: 5, maxRunsPerDay: 5 });
  await putKnowledge(f, 'K-old', '旧等待经验', '等五分钟再继续', ['src/login.mjs']);
  await observe(f, 1);
  await feedback(f.directory, { ...await identity(f), knowledgeId: 'K-old', outcome: 'shown', id: 'shown-1' });
  const project = await projectFor(f.directory, f.project);
  // 旧记录只有 taskId：会话过滤时不能算成本会话反馈，单列为任务级。
  await putItem(f.directory, project, 'feedback', { id: 'shown-task', knowledgeId: 'K-old', outcome: 'shown', taskId: f.taskId, at: '2026-10-29T00:00:00.000Z' });
  // 同一任务的其他会话材料不得混入。
  await putItem(f.directory, project, 'inbox', {
    id: 'other-session', incidentId: 'incident-other', kind: 'success', summary: '其他会话材料', conditions: '其他',
    evidence: ['test:other'], paths: [], knowledgeId: null, explicit: false, verified: true,
    createdAt: '2026-10-29T00:00:00.000Z', projectId: f.projectId, taskId: f.taskId, sessionId: 'session-other', status: 'pending',
  });
  // 只有 taskId 的迁移材料归入任务级。
  await putItem(f.directory, project, 'inbox', {
    id: 'task-only', incidentId: 'incident-task-only', kind: 'success', summary: '任务级材料', conditions: '迁移',
    evidence: ['test:task'], paths: [], knowledgeId: null, explicit: false, verified: true,
    createdAt: '2026-10-29T00:00:00.000Z', projectId: f.projectId, taskId: f.taskId, status: 'pending',
  });
  const first = await taskEnd(f, await writeTranscript(f, [transcriptLine(f.sessionId, 'user', '先检查日志')], 'first.jsonl'));
  assert.equal(first.result.extraction.status, 'registered');
  assert.equal((await extract(f, async () => ({ status: 'completed', answer: { candidates: [] } }))).status, 'completed');

  f.sessionId = 'session-2'; f.turnId = 'turn-2'; f.taskId = 'task-2';
  await event(f, 'UserPromptSubmit'); await start(f);
  await observe(f, 2);
  const second = await taskEnd(f, await writeTranscript(f, [transcriptLine(f.sessionId, 'user', '第二会话')], 'second.jsonl'));
  assert.equal(second.result.extraction.status, 'registered');
  assert.equal((await extract(f, async () => ({ status: 'completed', answer: { candidates: [] } }))).status, 'completed');

  // 新反馈事件带 sessionId，旧事件缺 sessionId 时不得冒充本会话。
  const stored = await readItems(f.directory, project, 'feedback');
  assert.equal(stored.find(item => item.id === 'shown-1').sessionId, 'session-1');
  assert.equal(stored.find(item => item.id === 'shown-task').sessionId, undefined);

  const scoped = await learningStatus(f.directory, f.project, new Date(), { sessionId: 'session-1', taskId: 'task-1' });
  assert.equal(scoped.materials.total, 1);
  assert.deepEqual({ shown: scoped.feedback.shown, adopted: scoped.feedback.adopted, total: scoped.feedback.total }, { shown: 1, adopted: 0, total: 1 });
  assert.equal(scoped.capture.total, 1);
  // 额度字段与实际执行判定一致，按项目累计并标注范围。
  assert.equal(scoped.capture.todayStarted, 2);
  assert.equal(scoped.capture.todayStartedScope, 'project');
  assert.deepEqual(scoped.limits.capture, { todayStarted: 2, maxRunsPerDay: 5, scope: 'project' });
  assert.deepEqual(scoped.limits.review, { todayStarted: 0, maxRunsPerDay: 5, scope: 'project' });
  assert.deepEqual(scoped.unattributed, {
    scope: 'task-level-or-unknown',
    taskLevel: { materials: 1, capture: 0, feedback: 1 },
    unknown: { materials: 0, capture: 0, feedback: 0 },
  });

  // 只按任务过滤时，任务级记录仍计入，但不会混入其他任务的会话。
  const byTask = await learningStatus(f.directory, f.project, new Date(), { taskId: 'task-1' });
  assert.equal(byTask.materials.total, 3);
  assert.equal(byTask.feedback.total, 2);
  assert.equal(byTask.unattributed, null);

  // 同时指定任务和会话时，同任务其他会话不参与统计。
  const both = await learningStatus(f.directory, f.project, new Date(), { taskId: 'task-1', sessionId: 'session-1' });
  assert.equal(both.materials.total, 1);
  assert.equal(both.capture.total, 1);
});
