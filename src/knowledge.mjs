import { digest, fail, mutate, readState } from './store.mjs';
import { currentIdentity, identifier, pendingFor, taskKey, textField } from './protocol.mjs';
import { resolveProject } from './projects.mjs';
import { document, safeDocument, writeDocuments } from './documents.mjs';
export { safeDocument } from './documents.mjs';

export function authorizeWrite(state, input) {
  const identity = currentIdentity(state, input);
  // 同一项目的任何 Lead 会话都可写；并发改同一文件由 baseline 指纹、写锁和事务恢复防覆盖。
  if (identity.task.permissions.mode !== 'write' || ['plan', 'read-only'].includes(identity.session.permissionMode)) fail('PERMISSION', '计划或只读任务不能写知识');
  return identity;
}
export async function inspectKnowledge(directory, root, relative) {
  const resolved = await resolveProject(await readState(directory), root);
  if (!resolved) fail('PROJECT', '当前目录没有有效项目绑定');
  return { projectId: resolved.project.projectId, path: relative, ...await document(await safeDocument(resolved.project.knowledgeRoot, relative)) };
}
function prepareCandidates(task, candidates = []) {
  if (!Array.isArray(candidates)) fail('CANDIDATE', '候选必须是数组');
  for (const c of candidates) {
    identifier(c.id, 'candidate.id');
    for (const key of ['taskId', 'workPackage', 'conditions', 'finding', 'recommendation']) textField(c[key], key);
    if (c.taskId !== task.taskId || !Array.isArray(c.evidence) || !c.evidence.length) fail('CANDIDATE', '候选需要当前任务和证据');
    const hash = digest(JSON.stringify(c));
    if (task.candidates[c.id] && task.candidates[c.id].hash !== hash) fail('CANDIDATE', '候选 ID 正文不同');
    task.candidates[c.id] ||= { ...c, hash, status: 'pending', transactionIds: [] };
  }
}
export function reconcileTransactions(state, projectId, taskId) {
  const transactions = Object.values(state.transactions).filter(t => t.projectId === projectId && t.taskId === taskId);
  for (const tx of transactions) {
    for (const f of tx.files) if (f.status !== 'applied' && transactions.some(t => t !== tx && t.createdAt >= tx.createdAt && t.files.some(n => n.path === f.path && n.after === f.after && n.status === 'applied' && f.candidateIds.every(c => n.candidateIds.includes(c))))) f.status = 'applied';
    tx.status = tx.files.length && tx.files.every(f => f.status === 'applied') ? 'applied' : tx.files.some(f => f.status === 'applied') ? 'partial' : 'pending';
    if (tx.status === 'applied') for (const p of Object.values(state.pending)) if (p.transactionId === tx.transactionId) p.status = 'closed';
  }
  const task = state.tasks[taskKey(projectId, taskId)];
  if (task) for (const c of Object.values(task.candidates)) {
    const refs = transactions.filter(t => t.files.some(f => f.candidateIds.includes(c.id)));
    const files = refs.flatMap(t => t.files.filter(f => f.candidateIds.includes(c.id)));
    c.status = files.length && files.every(f => f.status === 'applied') ? 'applied' : 'pending';
    c.transactionIds = refs.map(t => t.transactionId);
  }
}
export async function applyKnowledge(directory, input, options = {}) {
  return mutate(directory, async (state, save) => {
    const { project, session, task } = authorizeWrite(state, input);
    prepareCandidates(task, input.candidates);
    if (!Array.isArray(input.changes)) fail('INPUT', '缺少变更');
    for (const c of input.changes) {
      if (!task.permissions.allowedPaths.includes(c.path)) fail('PERMISSION', '资料不在已声明范围');
      if (!Array.isArray(c.candidateIds) || c.candidateIds.some(k => !task.candidates[k])) fail('CANDIDATE', '引用未知候选');
      if (c.candidateIds.some(k => task.candidates[k].status === 'applied')) {
        const current = await document(await safeDocument(project.knowledgeRoot, c.path));
        if (current.content !== c.content) fail('CANDIDATE', '已完整处置的候选不能重复合并到新正文');
      }
    }
    const tx = await writeDocuments(directory, state, save, project, input.changes, { taskId: task.taskId, sessionId: session.sessionId }, options);
    reconcileTransactions(state, project.projectId, task.taskId);
    let pending;
    if (tx.status !== 'applied') pending = pendingFor(state, project.projectId, task.taskId, '资料变更尚未完整写入', 'knowledge-pending', { transactionId: tx.transactionId });
    session.revision++;
    session.revisionReason = '知识写入';
    return { transactionId: tx.transactionId, status: tx.status, files: tx.files, revision: session.revision, ...(pending ? { pendingId: pending.pendingId } : {}) };
  });
}
export async function recoverTransaction(directory, transactionId, root) {
  return mutate(directory, async state => {
    const resolved = await resolveProject(state, root);
    const tx = state.transactions[transactionId];
    if (!resolved || !tx || tx.projectId !== resolved.project.projectId) fail('TRANSACTION', '事务不存在或不属于项目');
    for (const f of tx.files) {
      const current = await document(await safeDocument(resolved.project.knowledgeRoot, f.path));
      f.status = current.fingerprint === f.after ? 'applied' : current.fingerprint === f.before ? 'pending' : 'conflict';
    }
    reconcileTransactions(state, tx.projectId, tx.taskId);
    if (tx.status !== 'applied') pendingFor(state, tx.projectId, tx.taskId, '崩溃结果已辨认，保留未完成资料', 'knowledge-pending', { transactionId });
    return { transactionId, status: tx.status, files: tx.files, automaticWrites: 0 };
  });
}
export async function createPending(directory, input) {
  return mutate(directory, async state => {
    const { task, session } = currentIdentity(state, input);
    textField(input.reason, 'reason');
    const pending = pendingFor(state, input.projectId, task.taskId, input.reason, 'knowledge-pending', { evidence: input.evidence || [], candidateIds: input.candidateIds || [] });
    session.revision++;
    session.revisionReason = '知识待办';
    return { pendingId: pending.pendingId, revision: session.revision };
  });
}
