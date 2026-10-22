import { digest, fail, id, SCHEMA_VERSION } from './store.mjs';

export const PHASES = ['unknown', 'operation-only', 'executing', 'waiting-user', 'delivering'];
export const sessionKey = (projectId, sessionId) => digest(`${projectId}\0${sessionId}`);
export const taskKey = (projectId, taskId) => digest(`${projectId}\0${taskId}`);
export function textField(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) fail('INPUT', `缺少或无效字段 ${label}`);
  return value;
}
export function identifier(value, label) {
  textField(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('INPUT', `无效标识 ${label}`);
  return value;
}
export function openTurn(state, project, sessionId, turnId, { compact = false, eventId, mode } = {}) {
  identifier(sessionId, 'sessionId');
  identifier(turnId, 'turnId');
  const key = sessionKey(project.projectId, sessionId);
  let session = state.sessions[key];
  if (compact && session && session.turnId === turnId && !session.interrupted) return session;
  if (session && session.turnId === turnId && !session.interrupted) return session;
  session = {
    projectId: project.projectId, sessionId, taskId: session?.taskId || null, turnId,
    ticket: id('ticket'), interruptEpoch: session?.interruptEpoch || 0,
    revision: (session?.revision || 0) + 1, phase: 'unknown', interrupted: false,
    permissionMode: mode || 'unknown', eventId: eventId || null,
    receipts: session?.receipts || {}, observed: session?.observed || {},
  };
  state.sessions[key] = session;
  if (!project.leadSessions.includes(sessionId)) {
    project.leadSessions.push(sessionId);
    if (project.leadSessions.length === 1 && !project.ownerExplicit) project.ownerSessionId = sessionId;
    else if (!project.ownerExplicit) project.ownerSessionId = null;
  }
  return session;
}
export function currentIdentity(state, payload, { replay = false, requireTask = true } = {}) {
  if (payload?.schemaVersion !== SCHEMA_VERSION) fail('SCHEMA', '未知信号版本');
  for (const name of ['projectId', 'sessionId', 'taskId', 'turnId', 'ticket']) identifier(payload[name], name);
  const project = state.projects[payload.projectId];
  const session = state.sessions[sessionKey(payload.projectId, payload.sessionId)];
  if (!project?.enabled || !session) fail('IDENTITY', '项目或当前会话未接入');
  if (session.turnId !== payload.turnId || session.ticket !== payload.ticket || session.interruptEpoch !== payload.interruptEpoch || session.interrupted) fail('STALE', '票据或回合已失效');
  if (!replay && session.revision !== payload.expectedRevision) fail('REVISION', '状态已变化，请读取当前 context');
  const task = state.tasks[taskKey(payload.projectId, payload.taskId)];
  if (requireTask && (!task || session.taskId !== payload.taskId || task.lifecycle !== 'active')) fail('TASK', '任务未开始、已结束或不属于当前会话');
  return { project, session, task };
}
export function pendingFor(state, projectId, taskId, reason, kind = 'knowledge-pending', extra = {}) {
  const existing = Object.values(state.pending).find(p => p.projectId === projectId && p.taskId === taskId && p.kind === kind && p.status === 'open');
  if (existing) { existing.reason = reason; Object.assign(existing, extra); return existing; }
  const pending = { pendingId: id('pending'), projectId, taskId, kind, status: 'open', reason, createdAt: new Date().toISOString(), ...extra };
  state.pending[pending.pendingId] = pending;
  return pending;
}
export function validDisposition(state, payload, disposition) {
  if (!disposition || typeof disposition !== 'object') return false;
  if (disposition.status === 'no-new-learning') return typeof disposition.reason === 'string' && !!disposition.reason.trim();
  if (disposition.status === 'updated') {
    return Array.isArray(disposition.transactionIds) && disposition.transactionIds.length > 0 && disposition.transactionIds.every(transactionId => {
      const tx = state.transactions[transactionId];
      return tx?.projectId === payload.projectId && tx.taskId === payload.taskId && tx.sessionId === payload.sessionId && tx.status === 'applied' && tx.files.length > 0 && tx.files.every(f => f.status === 'applied');
    });
  }
  if (disposition.status === 'pending-recovery') {
    const pending = state.pending[disposition.pendingId];
    return typeof disposition.reason === 'string' && !!disposition.reason.trim() && pending?.projectId === payload.projectId && pending.taskId === payload.taskId && pending.kind === 'knowledge-pending' && pending.status === 'open';
  }
  return false;
}
export function acceptSignal(state, payload) {
  identifier(payload?.signalId, 'signalId');
  const initial = currentIdentity(state, payload, { replay: true, requireTask: false });
  const receipt = initial.session.receipts[payload.signalId];
  if (receipt) {
    if (receipt.hash !== digest(JSON.stringify(payload))) fail('SIGNAL_ID', '重复 signalId 正文不一致');
    return { ...receipt.result, replayed: true };
  }
  const { project, session } = currentIdentity(state, payload, { requireTask: false });
  const key = taskKey(project.projectId, payload.taskId);
  let task = state.tasks[key];
  if (payload.action === 'task-start') {
    if (session.taskId && session.taskId !== payload.taskId) {
      const previous = state.tasks[taskKey(project.projectId, session.taskId)];
      if (previous?.lifecycle === 'active') fail('TASK', '先明确结束当前任务，不能更换 ID 重置预算');
    }
    if (!task) {
      textField(payload.goal, 'goal');
      const permissions = payload.permissions;
      if (!permissions || !['write', 'read-only', 'plan'].includes(permissions.mode) || !Array.isArray(permissions.allowedPaths) || permissions.allowedPaths.some(p => typeof p !== 'string')) fail('PERMISSION', '任务需明确 mode 与 allowedPaths');
      task = { projectId: project.projectId, taskId: payload.taskId, goal: payload.goal, parentTaskId: payload.parentTaskId || null, lifecycle: 'active', repairIssued: false, deliveries: {}, candidates: {}, permissions, createdAt: new Date().toISOString() };
      state.tasks[key] = task;
    } else {
      if (task.lifecycle !== 'active' && !Object.values(state.pending).some(p => p.projectId === project.projectId && p.taskId === payload.taskId && p.kind === 'knowledge-pending' && p.status === 'open')) fail('TASK', '已完成任务无待接续知识');
      task.lifecycle = 'active';
    }
    session.taskId = payload.taskId;
    session.phase = 'executing';
  } else {
    currentIdentity(state, payload);
    if (payload.action === 'phase') {
      if (!PHASES.includes(payload.phase)) fail('PHASE', '未知任务阶段');
      if (payload.phase === 'delivering') identifier(payload.deliveryId, 'deliveryId');
      session.phase = payload.phase;
      if (payload.phase === 'delivering') {
        session.deliveryId = payload.deliveryId;
        task.deliveries[payload.deliveryId] ||= { deliveryId: payload.deliveryId, disposition: null };
      }
    } else if (payload.action === 'task-end') {
      if (session.phase === 'delivering' && !validDisposition(state, session, task.deliveries[session.deliveryId]?.disposition)) fail('DISPOSITION', '明确交付需先处置或留下可定位待办，再结束任务');
      task.lifecycle = 'complete';
      session.phase = 'unknown';
    } else if (payload.action !== 'disposition') fail('ACTION', '未知信号动作');
    if (payload.action === 'disposition' || payload.disposition) {
      if (payload.deliveryId !== session.deliveryId || !task.deliveries[payload.deliveryId]) fail('DELIVERY', '交付身份不匹配');
      if (!validDisposition(state, payload, payload.disposition)) fail('DISPOSITION', '无有效事务、理由或待办；未接受处置');
      task.deliveries[payload.deliveryId].disposition = payload.disposition;
      if (payload.disposition.status !== 'pending-recovery') {
        for (const pending of Object.values(state.pending)) {
          if (pending.projectId === project.projectId && pending.taskId === task.taskId && pending.kind === 'knowledge-pending') pending.status = 'closed';
        }
      }
    }
  }
  session.revision += 1;
  const result = { accepted: true, revision: session.revision, taskId: session.taskId, phase: session.phase };
  session.receipts[payload.signalId] = { hash: digest(JSON.stringify(payload)), result };
  return result;
}
export function stop(state, project, session, event = {}) {
  if (!session || session.interrupted || session.phase !== 'delivering') return {};
  const task = state.tasks[taskKey(project.projectId, session.taskId)];
  if (!task || task.lifecycle !== 'active') return {};
  const delivery = task.deliveries[session.deliveryId];
  if (validDisposition(state, session, delivery?.disposition)) return {};
  pendingFor(state, project.projectId, task.taskId, '明确交付缺少有效知识处置', 'knowledge-pending', { deliveryId: session.deliveryId });
  if (task.repairIssued || event.stop_hook_active === true || project.coexistenceMode === 'pending-only') return {};
  task.repairIssued = true;
  return { decision: 'block', reason: `workflow：任务 ${task.taskId} 已明确交付但缺少处置。本任务仅补此一轮：核对项目资料，提交 updated、no-new-learning 或 pending-recovery；只处理 workflow 知识待办，不恢复业务，不重跑其他插件。先用 context 取得当前身份。` };
}
export function interrupt(state, project, session) {
  if (!session || session.interrupted) return;
  session.interruptEpoch += 1;
  session.revision += 1;
  session.ticket = null;
  session.interrupted = true;
  session.phase = 'unknown';
  if (session.taskId) pendingFor(state, project.projectId, session.taskId, '业务被用户中断；仅保存，不自动继续', 'business-incomplete');
}
