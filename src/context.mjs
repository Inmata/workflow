import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readState } from './store.mjs';
import { sessionKey, taskKey } from './protocol.mjs';
import { resolveProject } from './projects.mjs';
import { inspectAlignment } from './alignment.mjs';
import { selectKnowledge } from './learning.mjs';

export const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function alignmentNote(role, alignment) {
  if (role !== 'lead') return '';
  if (!alignment.exists) return '项目尚未对齐：先读 alignmentGuide，按协议做只读扫描并把结论写入对齐文件；差异逐条询问用户，不擅自实施。';
  if (!alignment.docExists) return '项目对齐索引已建立但文档缺失：按协议生成对齐文件，差异逐条询问用户，不擅自实施。';
  if (alignment.stale) return `项目对齐索引已过期（${alignment.changed.length + alignment.missing.length + alignment.directoryChanged.length} 项变化）：只重读变化文件和新增资料，更新对齐文件，不重新全量扫描。`;
  if (alignment.pendingDecisions || alignment.pendingFindings) return `项目对齐还有 ${alignment.pendingDecisions} 项待裁决、${alignment.pendingFindings} 项结构建议；先逐条向用户确认。`;
  return '';
}
export async function projectContext(state, resolved, role = 'lead', sessionId, options = {}) {
  if (!['lead', 'worker', 'reviewer'].includes(role)) fail('ROLE', '未知角色');
  const project = resolved.project;
  const session = sessionId ? state.sessions[sessionKey(project.projectId, sessionId)] : null;
  const pending = Object.values(state.pending).filter(p => p.projectId === project.projectId && p.kind === 'knowledge-pending' && p.status === 'open').slice(0, 1);
  const identity = session && !session.interrupted ? { schemaVersion: 1, projectId: project.projectId, sessionId, taskId: session.taskId, turnId: session.turnId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision: session.revision } : null;
  const instructions = {
    lead: '首次或范围变化时读公共方法和 Lead 指引。新业务 task-start，提问前 waiting-user，交付后 task-end。明确纠正、失败原因或已验证方法出现时，按 learningGuide 用 knowledge capture 保存短材料；没有新材料直接交付。任务开始或范围变化用 knowledge select 检索适用经验，详细条目按需读取。当前用户要求优先于历史经验。',
    worker: '先读公共方法和 Worker 指引。只读工作包直接资料，必要的直接依赖可读；按阶段或范围变化说明【目标】和最小读取范围。不加载 Lead 调度，不递归创建代理。协作需要 workflow 身份而当前没有时，停止寻找并报告 Lead。复用有效证据；补测先说明具体缺口、最小测试和判定标准，由 Lead 裁定。发现随正常交付回报。',
    reviewer: '先读公共方法、Reviewer 指引和工作包指定范围。只读审查，不改源码、测试或配置，不递归创建代理。没有 workflow 身份时，停止寻找并报告 Lead。复用与待审版本匹配的证据；必要补测先说明具体缺口、最小测试和判定标准，由 Lead 裁定。完成即交回。',
  };
  const alignment = await inspectAlignment(project);
  const note = alignmentNote(role, alignment);
  const notices = role === 'lead' ? (project.learning?.notices || []).filter(n => !n.acknowledged && !n.deliveredAt) : [];
  if (options.incremental) for (const notice of notices) notice.deliveredAt = new Date().toISOString();
  const task = session?.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
  let knowledge;
  if (options.directory && task?.lifecycle === 'active') {
    knowledge = await selectKnowledge(options.directory, project.root, { text: task.goal, paths: task.permissions.allowedPaths });
    const key = JSON.stringify([task.taskId, task.goal, task.permissions.allowedPaths, knowledge.version]);
    if (options.incremental && session.contextKey === key) knowledge = { unchanged: true, version: knowledge.version };
    else if (options.incremental) session.contextKey = key;
  }
  return {
    enabled: true, projectId: project.projectId, root: project.root, worktree: resolved.worktree,
    role, documents: [path.join(PRODUCT_ROOT, 'docs', 'workflow.md'), path.join(PRODUCT_ROOT, 'docs', 'roles', `${role}.md`)],
    cli: path.join(PRODUCT_ROOT, 'bin', 'workflow.mjs'), identity,
    ownerSessionId: project.ownerSessionId, coexistenceMode: project.coexistenceMode, pending,
    alignment, knowledge, notices,
    learningGuide: path.join(PRODUCT_ROOT, 'docs', 'learning.md'),
    ...(role === 'lead' ? { alignmentGuide: path.join(PRODUCT_ROOT, 'docs', 'alignment.md') } : {}),
    instruction: note ? `${instructions[role]} ${note}` : instructions[role],
  };
}
export async function getContext(directory, cwd, role, sessionId) {
  const state = await readState(directory);
  const resolved = await resolveProject(state, cwd);
  if (!resolved) return { enabled: false, reason: '当前目录没有有效本机绑定' };
  return projectContext(state, resolved, role, sessionId, { directory });
}
