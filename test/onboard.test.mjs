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

test('onboard 核心预检不过时一次列出全部问题且不写入，学习问题单独报告', async () => {
  const f = await environment({ installed: false });
  await writeFile(path.join(f.project, 'AGENTS.md'), `# 约定\n${BEGIN}\n复制来的管理区\n<!-- workflow:end -->\n`);
  const result = await onboardProject(f.directory, f.project, { execute: async () => ({ code: 1, stdout: '', stderr: '' }) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.written, false);
  assert.deepEqual(result.problems.map(p => p.code).sort(), ['AGENTS', 'NOT_INSTALLED']);
  assert.equal(result.learning.status, 'failed');
  assert.equal(result.learning.requested, false);
  assert.equal(result.learning.enabled, false);
  assert.ok(result.problems.every(p => p.message));
  assert.ok(result.problems.find(p => p.code === 'NOT_INSTALLED').commands.every(c => c.startsWith('node ')));
  assert.deepEqual(Object.keys((await readState(f.directory)).projects), []);
  assert.ok((await readFile(path.join(f.project, 'AGENTS.md'), 'utf8')).includes('复制来的管理区'));
});

test('未请求启用学习时，学习预检失败只提示且核心接入仍完成', async () => {
  const f = await environment();
  const failing = async (file, args) => args[0] === '--version' ? { code: 1, stdout: '', stderr: 'not found' } : fakeExecute()(file, args);
  const result = await onboardProject(f.directory, f.project, { execute: failing });
  assert.equal(result.status, 'onboarded', JSON.stringify(result));
  assert.equal(result.written, true);
  assert.equal(result.learning.status, 'failed');
  assert.equal(result.learning.requested, false);
  assert.equal(result.learning.enabled, false);
  assert.ok(result.next.some(step => step.step.includes('预检未通过') && step.commands.some(c => c.includes('--enable-learning'))));
  assert.ok((await readFile(path.join(f.project, 'AGENTS.md'), 'utf8')).includes(BEGIN));
  const project = Object.values((await readState(f.directory)).projects)[0];
  assert.notEqual(project.learning?.enabled, true);
  // 既有 --skip-learning 出口仍可用：跳过预检并记下不启用。
  const g = await environment();
  const skipped = await onboardProject(g.directory, g.project, { skipLearning: true, execute: async () => { throw new Error('不应执行学习预检'); } });
  assert.equal(skipped.status, 'onboarded', JSON.stringify(skipped));
  assert.deepEqual(skipped.learning, { status: 'skipped', requested: false });
  assert.ok((await readFile(path.join(g.project, 'AGENTS.md'), 'utf8')).includes(BEGIN));
});

test('显式 --enable-learning 预检失败时核心与学习分别报告，学习不写成已启用', async () => {
  const f = await environment();
  const failing = async (file, args) => args[0] === '--version' ? { code: 1, stdout: '', stderr: 'not found' } : fakeExecute()(file, args);
  const result = await onboardProject(f.directory, f.project, { enableLearning: true, execute: failing });
  assert.equal(result.status, 'partial', JSON.stringify(result));
  assert.equal(result.written, true);
  assert.equal(result.learning.requested, true);
  assert.equal(result.learning.failure, 'preflight');
  assert.equal(result.learning.enabled, false);
  assert.equal(result.learning.schedule, 'not-registered');
  assert.notEqual(result.learning.status, 'capabilities-verified');
  assert.ok(result.next.some(step => step.step.includes('核心接入已完成') && step.commands.some(c => c.includes('--enable-learning'))));
  assert.ok(!result.next.some(step => step.step.includes('在项目目录开一个新会话') && step.commands));
  assert.ok((await readFile(path.join(f.project, 'AGENTS.md'), 'utf8')).includes(BEGIN));
  const project = Object.values((await readState(f.directory)).projects)[0];
  assert.notEqual(project.learning?.enabled, true);
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
  // 新会话：入口带版本与信号模板，不再有知识负责人字段；学习提示给用户终端执行的一步命令。
  const opened = await event(f, 'UserPromptSubmit');
  const injected = JSON.parse(opened.hookSpecificOutput.additionalContext.slice('workflow 入口：'.length));
  assert.equal(Object.hasOwn(injected, 'ownerSessionId'), false);
  assert.ok(injected.instruction.includes('--enable-learning'));
  assert.ok(injected.version && injected.signal.command.includes('signal <action> --session') && injected.signal.examples.some(e => e.includes('signal task-start')) && injected.signal.fallback.includes('signal --input') && injected.signal.fallback.includes('signal --base64'));
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

test('重复 onboard 只刷新管理区，保留学习开关、计划任务登记和对齐裁决', async () => {
  const f = await environment();
  const first = await onboardProject(f.directory, f.project, { execute: fakeExecute() });
  assert.equal(first.status, 'onboarded', JSON.stringify(first));
  await setLearningEnabled(f.directory, f.project, true);
  await mutate(f.directory, async state => {
    const project = state.projects[first.projectId];
    project.learning.schedule = { taskName: 'workflow-learning-keep' };
    project.alignment.decisions = [{ id: 'D1', status: 'accepted-project', decidedAt: '2026-10-01T00:00:00Z' }];
    project.alignment.findings = [{ id: 'F1', status: 'pending' }];
  });
  const again = await onboardProject(f.directory, f.project, { execute: fakeExecute() });
  assert.equal(again.status, 'onboarded', JSON.stringify(again));
  assert.equal(again.projectId, first.projectId);
  assert.equal(again.learning.enabled, true);
  assert.equal(again.learning.schedule, 'workflow-learning-keep');
  assert.ok(!again.next.some(step => step.commands?.some(c => c.includes('--enable-learning'))), '已启用学习时不再提示启用');
  const project = (await readState(f.directory)).projects[first.projectId];
  assert.equal(project.learning.enabled, true);
  assert.equal(project.learning.schedule.taskName, 'workflow-learning-keep');
  assert.deepEqual(project.alignment.decisions.map(d => [d.id, d.status]), [['D1', 'accepted-project']]);
  assert.deepEqual(project.alignment.findings.map(d => d.id), ['F1']);
  const agents = await readFile(path.join(f.project, 'AGENTS.md'), 'utf8');
  assert.equal(agents.split(BEGIN).length, 2, '管理区原位替换，不重复追加');
});

test('onboard --enable-learning 一次启用学习并注册计划任务；注册失败保留接入并给补跑命令', { skip: process.platform !== 'win32' }, async () => {
  const f = await environment();
  const calls = [];
  // 真实 schtasks 对未注册任务的 /Query 返回非零。
  const fresh = base => async (file, args) => file === 'schtasks.exe' && args[0] === '/Query' ? { code: 1, stdout: '', stderr: '' } : base(file, args);
  const done = await onboardProject(f.directory, f.project, { enableLearning: true, execute: fresh(fakeExecute(calls)) });
  assert.equal(done.status, 'onboarded', JSON.stringify(done));
  assert.equal(done.learning.enabled, true);
  assert.ok(done.learning.schedule.startsWith('workflow-learning-'));
  assert.ok(calls.some(c => c[0] === 'schtasks.exe' && c.includes('/Create')));
  assert.ok(!done.next.some(step => step.commands?.some(c => c.includes('--enable-learning'))));
  const project = Object.values((await readState(f.directory)).projects)[0];
  assert.equal(project.learning.enabled, true);
  assert.equal(project.learning.schedule.taskName, done.learning.schedule);
  // 学习已启用时入口仍报告现状，避免对齐交付漏报或被追问时重复注册。
  const lead = await getContext(f.directory, f.project, 'lead');
  assert.ok(lead.instruction.includes(`计划任务 ${done.learning.schedule} 已登记`) && !lead.instruction.includes('尚未启用'));

  const g = await environment();
  const failing = async (file, args) => file === 'schtasks.exe' && args[0] === '/Create' ? { code: 1, stdout: '', stderr: '拒绝访问' } : fresh(fakeExecute())(file, args);
  const partial = await onboardProject(g.directory, g.project, { enableLearning: true, execute: failing });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.written, true);
  assert.equal(partial.learning.enabled, true);
  assert.equal(partial.learning.schedule, 'not-registered');
  assert.ok(partial.next[0].step.includes('计划任务注册失败'));
  assert.ok(partial.next[0].commands.some(c => c.includes('learning schedule install') && c.includes('--root')));
  assert.equal(Object.values((await readState(g.directory)).projects)[0].learning.enabled, true, '学习已启用，只缺计划任务');
  assert.ok((await getContext(g.directory, g.project, 'lead')).instruction.includes('计划任务未登记'));
});

test('已启用学习的项目重复接入且预检失败时保留登记并据实报告', async () => {
  const f = await environment();
  const first = await onboardProject(f.directory, f.project, { execute: fakeExecute() });
  await setLearningEnabled(f.directory, f.project, true);
  await mutate(f.directory, async state => { state.projects[first.projectId].learning.schedule = { taskName: 'workflow-learning-existing' }; });
  const failing = async (file, args) => args[0] === '--version' ? { code: 1, stdout: '', stderr: 'not found' } : fakeExecute()(file, args);
  // 显式请求：核心接入完成，学习登记按实际报告，不写成未启用；本次预检失败用 partial 标记。
  const explicit = await onboardProject(f.directory, f.project, { enableLearning: true, execute: failing });
  assert.equal(explicit.status, 'partial', JSON.stringify(explicit));
  assert.equal(explicit.learning.requested, true);
  assert.equal(explicit.learning.failure, 'preflight');
  assert.equal(explicit.learning.enabled, true);
  assert.equal(explicit.learning.schedule, 'workflow-learning-existing');
  const step = explicit.next.find(item => item.step.includes('预检未通过'));
  assert.ok(step && !step.step.includes('后台复盘未启用'), JSON.stringify(explicit.next));
  assert.ok(step.step.includes('未改动现有后台复盘登记') && step.step.includes('workflow-learning-existing'));
  let project = (await readState(f.directory)).projects[first.projectId];
  assert.equal(project.learning.enabled, true);
  assert.equal(project.learning.schedule.taskName, 'workflow-learning-existing');
  // 未请求启用：顶层仍是 onboarded，且不再提示“后台复盘未启用”或重复启用。
  const quiet = await onboardProject(f.directory, f.project, { execute: failing });
  assert.equal(quiet.status, 'onboarded', JSON.stringify(quiet));
  assert.equal(quiet.learning.enabled, true);
  assert.equal(quiet.learning.schedule, 'workflow-learning-existing');
  assert.ok(!quiet.next.some(item => item.step.includes('后台复盘未启用')));
  assert.ok(!quiet.next.some(item => item.commands?.some(c => c.includes('--enable-learning'))));
  project = (await readState(f.directory)).projects[first.projectId];
  assert.equal(project.learning.enabled, true);
  assert.equal(project.learning.schedule.taskName, 'workflow-learning-existing');
});

test('CLI 退出码：显式 --enable-learning 预检失败为 1，未请求学习为 0', async () => {
  const f = await environment();
  // 指向确定不存在的执行器：预检失败，且不会触碰真实宿主执行器。
  await writeFile(path.join(f.directory, 'config.json'), JSON.stringify({ executor: 'codex', executorPath: path.join(f.area, 'missing-codex') }));
  const explicit = cli(['project', 'onboard', '--root', f.project, '--enable-learning', '--state-dir', f.directory]);
  const parsed = JSON.parse(explicit.stdout);
  assert.equal(parsed.status, 'partial', explicit.stdout);
  assert.equal(parsed.written, true);
  assert.equal(parsed.learning.failure, 'preflight');
  assert.equal(parsed.learning.requested, true);
  assert.equal(explicit.status, 1);

  const g = await environment();
  await writeFile(path.join(g.directory, 'config.json'), JSON.stringify({ executor: 'codex', executorPath: path.join(g.area, 'missing-codex') }));
  const optional = cli(['project', 'onboard', '--root', g.project, '--state-dir', g.directory]);
  const quieter = JSON.parse(optional.stdout);
  assert.equal(quieter.status, 'onboarded', optional.stdout);
  assert.equal(quieter.learning.enabled, false);
  assert.equal(optional.status, 0);
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
  assert.ok(text.includes('workflow 未接受') && text.includes('signal <action> --session') && text.includes('signal --input <完整 payload') && text.includes('变量赋值'));
  // 子命令写法的组合命令同样回执。
  const composedSub = await event(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `cd /x && node "${entry}" signal task-end --session s --turn t --id x` }, tool_response: { output: '{}' } });
  assert.match(composedSub.hookSpecificOutput.additionalContext, /workflow 未接受/);
  // --input 写法的组合命令同样回执。
  const composedFile = await event(f, 'PostToolUse', { tool_name: 'PowerShell', tool_input: { command: `cd D:/x; node "${entry}" signal --input s.json` }, tool_response: { output: '{}' } });
  assert.match(composedFile.hookSpecificOutput.additionalContext, /workflow 未接受/);
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

test('两个 Lead 会话先后写同一对齐文件：都能写，旧指纹返回 CONFLICT；project owner 只兼容不生效', async () => {
  const f = await fixture({ autoOwner: true });
  const other = { ...f, sessionId: 'session-2', turnId: 'turn-9', taskId: 'task-other' };
  await event(other, 'UserPromptSubmit');
  const allowed = { mode: 'write', allowedPaths: ['WORKFLOW-ALIGNMENT.md'] };
  await start(f, allowed);
  await start(other, allowed);
  const doc = path.join(f.project, 'WORKFLOW-ALIGNMENT.md');
  await writeFile(doc, '# 对齐\n');
  const before = digest(await readFile(doc));
  assert.equal((await applyAlignment(other.directory, other.project, { ...await identity(other), baseline: before, content: '# 对齐\n另一会话' })).status, 'applied');
  await assert.rejects(applyAlignment(f.directory, f.project, { ...await identity(f), baseline: before, content: '# 对齐\n本会话' }), { code: 'CONFLICT' });
  assert.equal((await applyAlignment(f.directory, f.project, { ...await identity(f), baseline: digest(await readFile(doc)), content: '# 对齐\n本会话' })).status, 'applied');
  const ignored = JSON.parse(cli(['project', 'owner', '--project', f.projectId, '--session', 'session-2', '--state-dir', f.directory]).stdout);
  assert.equal(ignored.status, 'ignored');
});

test('apply 自动登记表格里新的 pending 行；未登记却写了裁决状态的行拒绝并给 decide 命令', async () => {
  const f = await fixture();
  await start(f, { mode: 'write', allowedPaths: ['WORKFLOW-ALIGNMENT.md'] });
  const doc = path.join(f.project, 'WORKFLOW-ALIGNMENT.md');
  const table = (heading, rows) => `\n## ${heading}\n\n| ID | 内容 | 状态 |\n| --- | --- | --- |\n${rows.map(([id, status]) => `| ${id} | x | ${status} |`).join('\n')}\n`;
  const baseline = async () => { const bytes = await readFile(doc).catch(() => null); return bytes === null ? null : digest(bytes); };
  const applied = await applyAlignment(f.directory, f.project, { ...await identity(f), baseline: await baseline(), content: '# 对齐\n' + table('待裁决差异', [['D1', 'pending']]) + table('结构建议', [['F1', 'pending']]) });
  assert.deepEqual(applied.registered, ['D1', 'F1']);
  const project = Object.values((await readState(f.directory)).projects)[0];
  assert.deepEqual(project.alignment.decisions.map(d => [d.id, d.status]), [['D1', 'pending']]);
  assert.deepEqual(project.alignment.findings.map(d => [d.id, d.status]), [['F1', 'pending']]);
  const text = await readFile(doc, 'utf8');
  await assert.rejects(applyAlignment(f.directory, f.project, { ...await identity(f), baseline: await baseline(), content: '# 对齐\n' + table('待裁决差异', [['D1', 'pending'], ['D2', 'accepted-project']]) }), error => error.code === 'INPUT' && error.message.includes('D2（表格写的是 accepted-project）') && error.message.includes('project align decide'));
  assert.equal(await readFile(doc, 'utf8'), text, '拒绝时不写文档');
});
