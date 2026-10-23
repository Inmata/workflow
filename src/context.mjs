import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readState } from './store.mjs';
import { sessionKey, taskKey } from './protocol.mjs';
import { resolveProject } from './projects.mjs';
import { inspectAlignment } from './alignment.mjs';
import { selectKnowledge } from './learning.mjs';

export const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function alignmentNote(role, alignment, session, task) {
  if (role !== 'lead') return '';
  const note = alignmentAction(alignment);
  // 计划会话可扫描、提问和起草，写入被 authorizeWrite 拒绝；提示回到可写模式再 apply/decide，避免反复重试。
  // Codex 的 Plan 协作模式在 hook 中仍报 permission_mode=default，所以同时看活动任务声明的 plan 权限。
  const planning = session?.permissionMode === 'plan' || (task?.lifecycle === 'active' && task.permissions?.mode === 'plan');
  return note && planning ? `${note} 当前为计划模式：只扫描、提问和起草，不写文件；回到可写模式后再 apply/decide。` : note;
}
function alignmentAction(alignment) {
  if (!alignment.exists) return '项目尚未对齐：先读 alignmentGuide，按协议做只读扫描并把结论写入对齐文件；差异按提问路径询问用户，不擅自实施。';
  if (!alignment.docExists) return '项目对齐索引已建立但文档缺失：按协议生成对齐文件，差异按提问路径询问用户，不擅自实施。';
  if (alignment.stale) return `项目对齐索引已过期（${alignment.changed.length + alignment.missing.length + alignment.directoryChanged.length} 项变化）：只重读变化文件和新增资料，更新对齐文件，不重新全量扫描。`;
  if (alignment.pendingDecisions || alignment.pendingFindings) return `项目对齐还有 ${alignment.pendingDecisions} 项待裁决、${alignment.pendingFindings} 项结构建议；按提问路径向用户确认，可跨回合裁决。`;
  return '';
}
// 每包一行，不附结果正文：压缩后据此避免重复派工和重读已消费结果。
export function compactLedger(task) {
  const packages = Object.values(task?.packages || {});
  if (!task || (!packages.length && !task.route)) return null;
  return {
    route: task.route || null,
    packages: packages.map(p => [p.packageId, p.role, p.status, p.deliveredRef || '-', p.role === 'reviewer' ? `${p.verdict || '-'}@${p.reviews || '-'}:${p.reviewedRef || '-'}` : '-', p.attempts || 0].join(' ')),
    validation: task.validation ? task.validation.ref : null,
  };
}
export async function projectContext(state, resolved, role = 'lead', sessionId, options = {}) {
  if (!['lead', 'worker', 'reviewer'].includes(role)) fail('ROLE', '未知角色');
  const project = resolved.project;
  const session = sessionId ? state.sessions[sessionKey(project.projectId, sessionId)] : null;
  const pending = Object.values(state.pending).filter(p => p.projectId === project.projectId && p.kind === 'knowledge-pending' && p.status === 'open').slice(0, 1);
  const identity = session && !session.interrupted ? { schemaVersion: 1, projectId: project.projectId, sessionId, taskId: session.taskId, turnId: session.turnId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision: session.revision } : null;
  const instructions = {
    lead: '首次或范围变化时读公共方法和 Lead 指引。新业务 task-start 并声明 route（identity.taskId 为空时由 Lead 自拟 taskId，如 task-<简短英文>；续接已有任务沿用原 ID），提问前 waiting-user，派发/消费/审查结论用 packages 批量记录（派发时 handle 填委派 ID），交付后 task-end。明确纠正、失败原因或已验证方法出现时，按 learningGuide 用 knowledge capture 保存短材料；没有新材料直接交付。任务开始或范围变化用 knowledge select 检索适用经验，详细条目按需读取。当前用户要求优先于历史经验。若当前会话是受委派的工作包（任务给出 packageId 与 worker/reviewer 角色），不按 Lead 行事：先用 `node <cli> signal --base64 <identity 加 action=role-claim、role、packageId、signalId 的 JSON>` 声明角色，再读对应角色指引。',
    worker: '先读公共方法和 Worker 指引。只读工作包直接资料，必要的直接依赖可读；按阶段或范围变化说明【目标】和最小读取范围。不加载 Lead 调度，不递归创建代理，不发 task-start/packages。协作需要 workflow 身份而当前没有时，停止寻找并报告 Lead。复用有效证据；补测先说明具体缺口、最小测试和判定标准，由 Lead 裁定。发现随正常交付回报。',
    reviewer: '先读公共方法、Reviewer 指引和工作包指定范围。只读审查，不改源码、测试或配置，不递归创建代理，不发 task-start/packages。没有 workflow 身份时，停止寻找并报告 Lead。复用与待审版本匹配的证据；必要补测先说明具体缺口、最小测试和判定标准，由 Lead 裁定。完成即交回。',
  };
  const alignment = await inspectAlignment(project);
  const notices = role === 'lead' ? (project.learning?.notices || []).filter(n => !n.acknowledged && !n.deliveredAt) : [];
  if (options.incremental) for (const notice of notices) notice.deliveredAt = new Date().toISOString();
  const task = session?.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
  const note = alignmentNote(role, alignment, session, task);
  let knowledge;
  if (options.directory && task?.lifecycle === 'active') {
    knowledge = await selectKnowledge(options.directory, project.root, { text: task.goal, paths: task.permissions.allowedPaths });
    const key = JSON.stringify([task.taskId, task.goal, task.permissions.allowedPaths, knowledge.version]);
    if (options.incremental && session.contextKey === key) knowledge = { unchanged: true, version: knowledge.version };
    else if (options.incremental) session.contextKey = key;
  }
  const ledger = role === 'lead' && task?.lifecycle === 'active' ? compactLedger(task) : null;
  // 有包在途时提醒：用户新消息若改变需求，走中途纠正流程，而不是只在 Lead 侧记下。
  const inflight = ledger ? Object.values(task.packages || {}).filter(p => p.status === 'dispatched').map(p => p.packageId) : [];
  const correction = inflight.length ? `有 ${inflight.length} 个工作包在途（${inflight.join('、')}）：若本条用户消息改变需求或范围，按中途纠正流程先核对已有成果、取消并确认停止，再以新基准和用户原话重新派发。` : '';
  const instruction = [instructions[role], note, correction].filter(Boolean).join(' ');
  return {
    enabled: true, projectId: project.projectId, root: project.root, worktree: resolved.worktree,
    role, documents: [path.join(PRODUCT_ROOT, 'docs', 'workflow.md'), path.join(PRODUCT_ROOT, 'docs', 'roles', `${role}.md`)],
    cli: path.join(PRODUCT_ROOT, 'bin', 'workflow.mjs'), identity,
    ownerSessionId: project.ownerSessionId, coexistenceMode: project.coexistenceMode, pending,
    alignment, knowledge, notices,
    ...(ledger ? { ledger } : {}),
    learningGuide: path.join(PRODUCT_ROOT, 'docs', 'learning.md'),
    ...(role === 'lead' ? { alignmentGuide: path.join(PRODUCT_ROOT, 'docs', 'alignment.md') } : {}),
    instruction,
  };
}
export async function getContext(directory, cwd, role, sessionId) {
  const state = await readState(directory);
  const resolved = await resolveProject(state, cwd);
  if (!resolved) return { enabled: false, reason: '当前目录没有有效本机绑定' };
  return projectContext(state, resolved, role, sessionId, { directory });
}
