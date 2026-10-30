import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { enableProject } from '../src/projects.mjs';
import { getContext } from '../src/context.mjs';
import { handleHook } from '../src/hooks.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const entry = path.join(root, 'bin', 'workflow.mjs');
// store 的锁交错钩子只挂在全局符号上，不作为生产模块的导出句柄；测试通过这个键设置/清理。
export const LOCK_TEST_HOOKS = Symbol.for('workflow.lock-test-hooks');
// 知识检索的单文件读取故障注入点；用于稳定复现"读取失败但 size/mtimeMs 不变"的恢复场景。
export const KNOWLEDGE_TEST_HOOKS = Symbol.for('workflow.knowledge-test-hooks');
const temporaryAreas = new Set();
export async function temporary(prefix = 'case-') {
  const parent = path.join(tmpdir(), 'workflow-tests');
  await mkdir(parent, { recursive: true });
  const area = await mkdtemp(path.join(parent, prefix));
  temporaryAreas.add(area);
  return area;
}
export async function cleanupTemporaryAreas() {
  await Promise.all([...temporaryAreas].map(area => rm(area, { recursive: true, force: true })));
  temporaryAreas.clear();
}
after(cleanupTemporaryAreas);
export function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=workflow-test', '-c', 'user.email=workflow-test@example.invalid', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
export async function fixture(options = {}) {
  const area = await temporary();
  const project = path.join(area, 'project');
  const directory = path.join(area, 'state');
  await mkdir(project);
  if (options.git) git(project, ['init', '-b', 'main']);
  await writeFile(path.join(project, 'README.md'), '# 项目\n原始内容\n');
  const binding = await enableProject(directory, project, { owner: options.autoOwner ? undefined : 'session-1', coexistenceMode: options.coexistenceMode });
  const f = { area, project, directory, projectId: binding.projectId, sessionId: 'session-1', turnId: 'turn-1', promptId: 'prompt-1', taskId: 'task-1' };
  if (options.claude) await claudeEvent(f, 'UserPromptSubmit');
  else await event(f, 'UserPromptSubmit');
  return f;
}
// 需要具体 ref 的用例用真实 Git 仓库：finalRef 等标签必须能解析成提交，显式 ref 才不按读取失败处理。
export async function gitFixture(tags = []) {
  const f = await fixture({ git: true });
  git(f.project, ['add', '-A']);
  git(f.project, ['commit', '-q', '-m', 'init']);
  for (const tag of tags) git(f.project, ['tag', tag]);
  return f;
}
export async function event(f, name, extra = {}) {
  return handleHook(f.directory, { hook_event_name: name, cwd: f.project, session_id: f.sessionId, turn_id: f.turnId, permission_mode: 'default', ...extra }, { synthetic: true, entry });
}
// Claude Code 事件没有 turn_id，用 prompt_id 关联同一用户回合；hook 输出结构与 Codex 同形。
export async function claudeEvent(f, name, extra = {}) {
  return handleHook(f.directory, { hook_event_name: name, cwd: f.project, session_id: f.sessionId, prompt_id: f.promptId, permission_mode: 'default', ...extra }, { synthetic: true, entry, agent: 'claude' });
}
export async function identity(f) { return (await getContext(f.directory, f.project, 'lead', f.sessionId)).identity; }
export async function emit(f, value) {
  const payload = { ...await identity(f), taskId: f.taskId, signalId: `signal-${crypto.randomUUID()}`, ...value };
  const output = await event(f, 'PostToolUse', {
    tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` },
    tool_response: { output: JSON.stringify({ workflow_signal: payload }) },
  });
  const text = output.hookSpecificOutput?.additionalContext;
  assert.ok(text?.startsWith('workflow 回执：'), JSON.stringify(output));
  return { payload, result: JSON.parse(text.slice('workflow 回执：'.length)) };
}
export async function claudeEmit(f, value) {
  const payload = { ...await identity(f), taskId: f.taskId, signalId: `signal-${crypto.randomUUID()}`, ...value };
  const output = await claudeEvent(f, 'PostToolUse', {
    tool_name: 'Bash', tool_input: { command: `node "${entry}" signal --base64 e30=` },
    tool_response: { stdout: JSON.stringify({ workflow_signal: payload }), stderr: '', interrupted: false },
  });
  const text = output.hookSpecificOutput?.additionalContext;
  assert.ok(text?.startsWith('workflow 回执：'), JSON.stringify(output));
  return { payload, result: JSON.parse(text.slice('workflow 回执：'.length)) };
}
export async function claudeStart(f, permissions = { mode: 'write', allowedPaths: ['README.md', 'LESSONS.md', 'docs/说明.md'] }) {
  const result = await claudeEmit(f, { action: 'task-start', goal: 'Claude 隔离验证任务', route: 'lead-direct', permissions });
  assert.equal(result.result.accepted, true, JSON.stringify(result));
  return result;
}
export async function start(f, permissions = { mode: 'write', allowedPaths: ['README.md', 'LESSONS.md', 'docs/说明.md'] }) {
  const result = await emit(f, { action: 'task-start', goal: '隔离验证任务', route: 'lead-direct', permissions });
  assert.equal(result.result.accepted, true, JSON.stringify(result));
  return result;
}
export const deliver = (f, disposition, deliveryId = 'delivery-1') => emit(f, { action: 'phase', phase: 'delivering', deliveryId, ...(disposition ? { disposition } : {}) });
// 回合结束核对：活动任务未 task-end 时挡一次，提醒结束任务或说明剩余事项；从不要求补写经验。
export function assertRoundCheck(output) {
  assert.equal(output.decision, 'block', JSON.stringify(output));
  assert.match(output.reason, /task-end/);
  assert.doesNotMatch(output.reason, /经验|复盘/);
}
export function cli(args, options = {}) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, cwd: root, ...options });
}
// 已退出子进程的 pid：用来模拟崩溃进程遗留的锁，不依赖当前进程存活判断。
export function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true });
  const pid = Number(String(child.stdout || '').replace(/\u001b\[\d+m/g, '').trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `无法取得子进程 pid：${child.stdout}`);
  return pid;
}
