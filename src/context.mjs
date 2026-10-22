import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readState } from './store.mjs';
import { sessionKey } from './protocol.mjs';
import { resolveProject } from './projects.mjs';

export const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function projectContext(state, resolved, role = 'lead', sessionId) {
  if (!['lead', 'worker', 'reviewer'].includes(role)) fail('ROLE', '未知角色');
  const project = resolved.project;
  const session = sessionId ? state.sessions[sessionKey(project.projectId, sessionId)] : null;
  const pending = Object.values(state.pending).filter(p => p.projectId === project.projectId && p.kind === 'knowledge-pending' && p.status === 'open').slice(0, 1);
  const identity = session && !session.interrupted ? { schemaVersion: 1, projectId: project.projectId, sessionId, taskId: session.taskId, turnId: session.turnId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision: session.revision } : null;
  const instructions = {
    lead: '先读公共方法和 Lead 指引。使用 context 返回的 documents 路径派工，不手写角色入口。新业务显式 task-start，已有任务接续沿用 taskId；当前 phase 未知，不从 Stop 猜完成。提问前 waiting-user，例行操作 operation-only，交付 disposition 后 task-end。只恢复一项知识待办，不恢复被停止业务。',
    worker: '先读公共方法和 Worker 指引。只读工作包直接资料，必要的直接依赖可读；按阶段或范围变化说明【目标】和最小读取范围。不加载 Lead 调度，不递归创建代理。协作需要 workflow 身份而当前没有时，停止寻找并报告 Lead。复用有效证据；补测先说明具体缺口、最小测试和判定标准，由 Lead 裁定。发现随正常交付回报。',
    reviewer: '先读公共方法、Reviewer 指引和工作包指定范围。只读审查，不改源码、测试或配置，不递归创建代理。没有 workflow 身份时，停止寻找并报告 Lead。复用与待审版本匹配的证据；必要补测先说明具体缺口、最小测试和判定标准，由 Lead 裁定。完成即交回。',
  };
  return {
    enabled: true, projectId: project.projectId, root: project.root, worktree: resolved.worktree,
    role, documents: [path.join(PRODUCT_ROOT, 'docs', 'workflow.md'), path.join(PRODUCT_ROOT, 'docs', 'roles', `${role}.md`)],
    cli: path.join(PRODUCT_ROOT, 'bin', 'workflow.mjs'), identity,
    ownerSessionId: project.ownerSessionId, coexistenceMode: project.coexistenceMode, pending,
    instruction: instructions[role],
  };
}
export async function getContext(directory, cwd, role, sessionId) {
  const state = await readState(directory);
  const resolved = await resolveProject(state, cwd);
  if (!resolved) return { enabled: false, reason: '当前目录没有有效本机绑定' };
  return projectContext(state, resolved, role, sessionId);
}
