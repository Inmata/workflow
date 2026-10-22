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
  const f = { area, project, directory, projectId: binding.projectId, sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1' };
  await event(f, 'UserPromptSubmit');
  return f;
}
export async function event(f, name, extra = {}) {
  return handleHook(f.directory, { hook_event_name: name, cwd: f.project, session_id: f.sessionId, turn_id: f.turnId, permission_mode: 'default', ...extra }, { synthetic: true, entry });
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
export async function start(f, permissions = { mode: 'write', allowedPaths: ['README.md', 'LESSONS.md', 'docs/说明.md'] }) {
  const result = await emit(f, { action: 'task-start', goal: '隔离验证任务', permissions });
  assert.equal(result.result.accepted, true, JSON.stringify(result));
  return result;
}
export const deliver = (f, disposition, deliveryId = 'delivery-1') => emit(f, { action: 'phase', phase: 'delivering', deliveryId, ...(disposition ? { disposition } : {}) });
export function cli(args, options = {}) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, cwd: root, ...options });
}
