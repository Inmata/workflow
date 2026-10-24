import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { install } from '../src/install.mjs';
import { onboardProject, removeProject, learningDoctor } from '../src/onboard.mjs';
import { alignmentStatus, applyAlignment, decideAlignment, suggestAlignment } from '../src/alignment.mjs';
import { getContext } from '../src/context.mjs';
import { handleHook } from '../src/hooks.mjs';
import { setLearningEnabled } from '../src/learning-config.mjs';
import { digest, mutate, readState } from '../src/store.mjs';
import { BEGIN } from '../src/projects.mjs';
import { sessionKey } from '../src/protocol.mjs';
import { cli, entry, fixture, event, identity, start, temporary } from './helpers.mjs';

const CLAUDE_HELP = ['--bare', '--setting-sources', '--settings', '--strict-mcp-config', '--tools', '--json-schema', '--output-format', '--no-session-persistence', '--include-hook-events'].join('\n');
// 假的 Claude CLI 与 schtasks：只回答能力核对和任务注册，不调用模型。
const fakeExecute = calls => async (file, args) => {
  calls?.push([path.basename(file), ...args]);
  if (args[0] === '--version') return { code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' };
  if (args[0] === '--help') return { code: 0, stdout: CLAUDE_HELP, stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
async function environment({ installed = true, settings = true } = {}) {
  const area = await temporary('onboard-');
  const directory = path.join(area, 'state'), project = path.join(area, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'README.md'), '# 项目\n');
  await mkdir(path.join(project, 'docs'));
  await writeFile(path.join(project, 'docs', 'usage.md'), '# 使用\n');
  if (installed) {
    const userDir = path.join(area, 'user', '.codex');
    await mkdir(userDir, { recursive: true });
    assert.equal((await install(directory, { userDir })).status, 'installed');
  }
  await mkdir(directory, { recursive: true });
  const settingsFile = path.join(area, 'claude-learning.json');
  await writeFile(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, model: 'test-model' }));
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ executor: 'claude', claudePath: 'claude', ...(settings ? { claudeSettings: settingsFile } : {}) }));
  return { area, directory, project, sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-align' };
}

test('onboard 预检不过时一次列出全部问题且不写入', async () => {
  const f = await environment({ installed: false });
  await writeFile(path.join(f.project, 'AGENTS.md'), `# 约定\n${BEGIN}\n复制来的管理区\n<!-- workflow:end -->\n`);
  const result = await onboardProject(f.directory, f.project, { execute: async () => ({ code: 1, stdout: '', stderr: '' }) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.written, false);
  assert.deepEqual(result.problems.map(p => p.code).sort(), ['AGENTS', 'LEARNING', 'NOT_INSTALLED']);
  assert.ok(result.problems.every(p => p.message));
  assert.ok(result.problems.find(p => p.code === 'NOT_INSTALLED').commands.every(c => c.startsWith('node ')));
  assert.deepEqual(Object.keys((await readState(f.directory)).projects), []);
  assert.ok((await readFile(path.join(f.project, 'AGENTS.md'), 'utf8')).includes('复制来的管理区'));
});

test('onboard → 对齐 → 裁决 → 启用学习 → remove 全流程无残留', async () => {
  const f = await environment();
  const calls = [];
  const onboarded = await onboardProject(f.directory, f.project, { execute: fakeExecute(calls) });
  assert.equal(onboarded.status, 'onboarded', JSON.stringify(onboarded));
  assert.equal(onboarded.learning.status, 'capabilities-verified');
  assert.deepEqual(onboarded.warnings, []);
  assert.ok(onboarded.alignment.indexedFiles > 0);
  assert.ok(onboarded.next[0].commands.every(c => c.startsWith('node ') && c.includes('--root')));
  assert.ok(!calls.some(c => c.includes('-p')), '预检不得调用模型');
  assert.ok((await readFile(path.join(f.project, 'AGENTS.md'), 'utf8')).includes(BEGIN));
  // 新会话：唯一 Lead 会话自动成为知识负责人，入口带版本与信号模板。
  const opened = await event(f, 'UserPromptSubmit');
  const injected = JSON.parse(opened.hookSpecificOutput.additionalContext.slice('workflow 入口：'.length));
  assert.equal(injected.ownerSessionId, f.sessionId);
  assert.ok(injected.version && injected.signal.command.includes('signal --base64'));
  assert.ok(injected.instruction.includes('learning doctor'));
  f.projectId = injected.projectId;
  await start(f, { mode: 'write', allowedPaths: ['docs/WORKFLOW-ALIGNMENT.md'] });
  const doc = path.join(f.project, 'docs', 'WORKFLOW-ALIGNMENT.md');
  const write = async (operation, input) => {
    const bytes = await readFile(doc).catch(() => null);
    return operation(f.directory, f.project, { ...await identity(f), baseline: bytes === null ? null : digest(bytes), ...input });
  };
  await write(applyAlignment, { content: '# 项目对齐\n\n## 待裁决差异\n\n| ID | 项目做法 | 默认 | 影响 | 建议 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| D1 | a | b | c | d | pending |\n\n## 已裁决记录\n' });
  await write(suggestAlignment, { findings: [{ id: 'F1', problem: '目录混乱', recommendation: '合并' }] });
  // 结构建议用了差异专用状态：报错列出合法值，不让代理去手改表格。
  await assert.rejects(write(decideAlignment, { decisions: [{ id: 'F1', status: 'accepted-project' }] }), error => error.code === 'INPUT' && error.message.includes('accepted-change、rejected'));
  await write(decideAlignment, { decisions: [{ id: 'D1', status: 'accepted-project', reason: '用户确认' }, { id: 'F1', status: 'accepted-change', reason: '用户同意' }] });
  const status = await alignmentStatus(f.directory, f.project);
  assert.equal(status.stale, false, JSON.stringify(status));
  assert.equal(status.pendingDecisions, 0);
  assert.equal(status.pendingFindings, 0);
  assert.deepEqual(status.mismatch, []);
  await setLearningEnabled(f.directory, f.project, true);
  await mutate(f.directory, async state => { state.projects[f.projectId].learning.schedule = { taskName: 'workflow-learning-test' }; });
  await mkdir(path.join(f.directory, 'projects', f.projectId, 'candidates'), { recursive: true });
  const removed = await removeProject(f.directory, f.project, { execute: fakeExecute(calls) });
  assert.equal(removed.status, 'removed');
  assert.equal(removed.schedule, 'removed');
  assert.ok(calls.some(c => c[0] === 'schtasks.exe' && c.includes('workflow-learning-test')));
  assert.ok(removed.kept.some(item => item.path === 'docs/WORKFLOW-ALIGNMENT.md'));
  const state = await readState(f.directory);
  assert.equal(state.projects[f.projectId], undefined);
  for (const key of ['sessions', 'tasks', 'pending', 'transactions']) assert.ok(Object.values(state[key]).every(item => item.projectId !== f.projectId), key);
  assert.equal(await lstat(path.join(f.directory, 'projects', f.projectId)).catch(() => null), null);
  assert.deepEqual(await readdir(path.join(f.directory, 'project-changes')), []);
  assert.ok(!(await readFile(path.join(f.project, 'AGENTS.md'), 'utf8')).includes(BEGIN));
  // 清除后可一步重新接入。
  assert.equal((await onboardProject(f.directory, f.project, { execute: fakeExecute() })).status, 'onboarded');
});

test('learning doctor 缺专用配置时警告并给出完整命令；--global 无需绑定', async () => {
  const f = await environment({ settings: false });
  const report = await learningDoctor(f.directory, null, { execute: fakeExecute() });
  assert.equal(report.status, 'capabilities-verified');
  assert.equal(report.warnings[0].code, 'CLAUDE_SETTINGS');
  assert.ok(report.warnings[0].command.includes('learning config set --global --base64'));
  const viaCli = cli(['learning', 'doctor', '--global', '--state-dir', f.directory]);
  const parsed = JSON.parse(viaCli.stdout);
  assert.equal(parsed.executor, 'claude');
  assert.notEqual(parsed.error, 'PROJECT');
});

test('对齐表格被手改时报告 mismatch；目录里只多了非资料文件不算过期', async () => {
  const f = await fixture();
  await start(f, { mode: 'write', allowedPaths: ['docs/WORKFLOW-ALIGNMENT.md'] });
  await mkdir(path.join(f.project, 'docs'), { recursive: true });
  const doc = path.join(f.project, 'docs', 'WORKFLOW-ALIGNMENT.md');
  await decideAlignment(f.directory, f.project, { ...await identity(f), baseline: null, docPath: 'docs/WORKFLOW-ALIGNMENT.md', decisions: [{ id: 'D1', status: 'pending' }] }).catch(async () => {
    await writeFile(doc, '# 对齐\n');
    return decideAlignment(f.directory, f.project, { ...await identity(f), baseline: digest(await readFile(doc)), decisions: [{ id: 'D1', status: 'pending' }] });
  });
  const text = await readFile(doc, 'utf8');
  await writeFile(doc, `${text}\n## 待裁决差异\n\n| ID | 做法 | 状态 |\n| --- | --- | --- |\n| D1 | x | accepted |\n`);
  await writeFile(path.join(f.project, 'docs', 'image.png'), 'x');
  const status = await alignmentStatus(f.directory, f.project);
  assert.deepEqual(status.directoryChanged, []);
  assert.deepEqual(status.mismatch, [{ id: 'D1', document: 'accepted', index: 'pending', invalid: true }]);
  const context = await getContext(f.directory, f.project, 'lead', f.sessionId);
  assert.ok(context.instruction.includes('不要手改表格'));
  await writeFile(path.join(f.project, 'docs', 'new.md'), '# 新资料\n');
  assert.deepEqual((await alignmentStatus(f.directory, f.project)).directoryChanged, ['docs']);
});

test('组合命令里的 signal 回执附模板；REVISION 拒绝附当前 revision 与原因', async () => {
  const f = await fixture();
  await start(f);
  const composed = await event(f, 'PostToolUse', { tool_name: 'PowerShell', tool_input: { command: `$wf="${entry}"; node $wf signal --base64 e30=` }, tool_response: { output: '{}' } });
  const text = composed.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('workflow 未接受') && text.includes('signal --base64 <UTF-8 JSON 的 base64>') && text.includes('变量赋值'));
  const stale = { ...await identity(f) };
  await event(f, 'PostToolUse', { tool_name: 'request_user_input', tool_input: {}, tool_response: {} });
  const output = await event(f, 'PostToolUse', {
    tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` },
    tool_response: { output: JSON.stringify({ workflow_signal: { ...stale, taskId: f.taskId, signalId: 'signal-stale', action: 'phase', phase: 'executing' } }) },
  });
  const receipt = JSON.parse(output.hookSpecificOutput.additionalContext.slice('workflow 回执：'.length));
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.reason, 'REVISION');
  assert.equal(receipt.expectedRevision, stale.expectedRevision + 1);
  assert.ok(receipt.message.includes('提问工具'));
});

test('插件在会话中途升级时提示开新会话；旧发布副本的入口仍接受信号', async () => {
  const f = await fixture();
  await mutate(f.directory, async state => { for (const s of Object.values(state.sessions)) s.productVersion = '0.0.1'; });
  const output = await event(f, 'UserPromptSubmit', { turn_id: 'turn-2' });
  assert.ok(output.hookSpecificOutput.additionalContext.startsWith('workflow 插件已从 0.0.1 升级'));
  const old = path.join(f.directory, 'releases', '0.0.1-old', 'bin');
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, 'workflow.mjs'), '');
  f.turnId = 'turn-2';
  const payload = { ...await identity(f), taskId: f.taskId, signalId: 'signal-old-entry', action: 'task-start', goal: '旧入口', permissions: { mode: 'read-only', allowedPaths: [] } };
  const accepted = await handleHook(f.directory, { hook_event_name: 'PostToolUse', cwd: f.project, session_id: f.sessionId, turn_id: f.turnId, tool_name: 'Bash', tool_input: { command: `node "${path.join(old, 'workflow.mjs')}" signal --base64 e30=` }, tool_response: { output: JSON.stringify({ workflow_signal: payload }) } }, { synthetic: true, entry });
  assert.ok(accepted.hookSpecificOutput.additionalContext.startsWith('workflow 回执：{"accepted":true'), JSON.stringify(accepted));
});

test('多个 Lead 会话时 OWNER 报错给出指定命令；长时间无回合的会话不参与推定', async () => {
  const f = await fixture({ autoOwner: true });
  const other = { ...f, sessionId: 'session-2', turnId: 'turn-9' };
  await event(other, 'UserPromptSubmit');
  let state = await readState(f.directory);
  assert.equal(state.projects[f.projectId].ownerSessionId, null);
  await start(f, { mode: 'write', allowedPaths: ['docs/WORKFLOW-ALIGNMENT.md'] });
  await writeFile(path.join(f.project, 'WORKFLOW-ALIGNMENT.md'), '# 对齐\n');
  await assert.rejects(applyAlignment(f.directory, f.project, { ...await identity(f), baseline: null, content: 'x' }), error => error.code === 'OWNER' && error.message.includes('project owner --project') && error.message.includes('2 个 Lead 会话'));
  await mutate(f.directory, async current => { current.sessions[sessionKey(f.projectId, 'session-2')].lastSeenAt = '2000-01-01T00:00:00.000Z'; });
  await event({ ...f, turnId: 'turn-3' }, 'UserPromptSubmit');
  state = await readState(f.directory);
  assert.equal(state.projects[f.projectId].ownerSessionId, f.sessionId);
});
