import { digest, fail, id, SCHEMA_VERSION, WorkflowError } from './store.mjs';

export const PHASES = ['unknown', 'operation-only', 'executing', 'waiting-user', 'delivering'];
export const ROUTES = ['operation-only', 'lead-direct', 'delegated'];
export const PACKAGE_STATUSES = ['dispatched', 'delivered', 'consumed', 'canceled', 'failed', 'waived'];
export const TERMINAL_PACKAGE = ['consumed', 'canceled', 'failed', 'waived'];
export const VERDICTS = ['PASS', 'FIX', 'BLOCKED'];
const REPAIR_LIMIT = 2;
const MAX_PACKAGES = 200;
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
    permissionMode: mode || 'unknown', eventId: eventId || null, lastSeenAt: new Date().toISOString(),
    receipts: session?.receipts || {}, observed: session?.observed || {}, contextKey: session?.contextKey,
    // role-claim 声明的子角色跨回合保留；未声明的会话按 Lead 处理。
    ...(session?.role ? { role: session.role, packageId: session.packageId || null } : {}),
  };
  state.sessions[key] = session;
  return session;
}
export function currentIdentity(state, payload, { replay = false, requireTask = true } = {}) {
  if (payload?.schemaVersion !== SCHEMA_VERSION) fail('SCHEMA', '未知信号版本');
  for (const name of ['projectId', 'sessionId', 'taskId', 'turnId', 'ticket']) identifier(payload[name], name);
  const project = state.projects[payload.projectId];
  const session = state.sessions[sessionKey(payload.projectId, payload.sessionId)];
  if (!project?.enabled || !session) fail('IDENTITY', '项目或当前会话未接入');
  if (session.turnId !== payload.turnId || session.ticket !== payload.ticket || session.interruptEpoch !== payload.interruptEpoch || session.interrupted) fail('STALE', '票据或回合已失效');
  if (!replay && session.revision !== payload.expectedRevision) fail('REVISION', `状态已变化（当前 revision=${session.revision}，你给的是 ${payload.expectedRevision}，最近变化：${session.revisionReason || '信号或写入'}）：把 expectedRevision 改为 ${session.revision} 后重发，或读取当前 context`);
  const task = state.tasks[taskKey(payload.projectId, payload.taskId)];
  if (requireTask && (!task || session.taskId !== payload.taskId || task.lifecycle !== 'active')) fail('TASK', '任务未开始、已结束或不属于当前会话');
  return { project, session, task };
}
export function pendingFor(state, projectId, taskId, reason, kind = 'knowledge-pending', extra = {}) {
  const scope = extra.transactionId || extra.deliveryId || digest(JSON.stringify({ reason, candidateIds: extra.candidateIds || [] }));
  const existing = Object.values(state.pending).find(p => p.projectId === projectId && p.taskId === taskId && p.kind === kind && p.status === 'open' && (p.transactionId || p.deliveryId || p.scope) === scope);
  if (existing) { existing.reason = reason; Object.assign(existing, extra); return existing; }
  const pending = { pendingId: id('pending'), projectId, taskId, kind, scope, status: 'open', reason, createdAt: new Date().toISOString(), ...extra };
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
const optionalText = (value, label) => value === undefined || value === null ? null : textField(value, label);
const optionalRef = (value, label) => value === undefined || value === null ? null : identifier(value, label);
function packageInput(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail('PACKAGE', '工作包记录必须是对象');
  identifier(item.packageId, 'packageId');
  if (item.role !== undefined && !['worker', 'reviewer'].includes(item.role)) fail('PACKAGE', '工作包 role 只能是 worker 或 reviewer');
  if (item.status !== undefined && !PACKAGE_STATUSES.includes(item.status)) fail('PACKAGE', '未知工作包状态');
  if (item.verdict !== undefined && item.verdict !== null && !VERDICTS.includes(item.verdict)) fail('PACKAGE', '未知审查结论');
  if (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || item.dependsOn.length > 50)) fail('PACKAGE', 'dependsOn 必须是数组');
  for (const dependency of item.dependsOn || []) identifier(dependency, 'dependsOn');
  for (const key of ['handle', 'worktree', 'note']) optionalText(item[key], key);
  for (const key of ['baseRef', 'deliveredRef', 'reviewedRef', 'reviews']) optionalRef(item[key], key);
  return item;
}
function validationInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VALIDATION', 'validation 需为 {ref, evidence[]}');
  identifier(value.ref, 'validation.ref');
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 50) fail('VALIDATION', 'validation.evidence 需非空数组');
  value.evidence.forEach((item, index) => textField(item, `validation.evidence[${index}]`));
  return { ref: value.ref, evidence: value.evidence };
}
function waiverInput(value) {
  if (!Array.isArray(value) || value.length > 50) fail('WAIVER', 'waivers 需为数组');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('WAIVER', '豁免需为 {step, reason}');
    return { step: textField(item.step, 'waiver.step'), reason: textField(item.reason, 'waiver.reason') };
  });
}
// 账本只在派发、消费结果、审查结论三个节点记录；批量 upsert，未给出的字段保持原值。
export function upsertPackages(task, items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) fail('PACKAGE', 'packages 需为 1-50 项数组');
  task.packages ||= {};
  const repairLimit = [];
  for (const item of items.map(packageInput)) {
    const previous = task.packages[item.packageId];
    if (!previous && (!item.role || !item.status)) fail('PACKAGE', '新工作包需给出 role 与 status');
    if (!previous && Object.keys(task.packages).length >= MAX_PACKAGES) fail('PACKAGE', '工作包数量超过上限');
    const next = { attempts: 0, dependsOn: [], ...previous, packageId: item.packageId };
    for (const key of ['role', 'status', 'handle', 'worktree', 'baseRef', 'deliveredRef', 'reviewedRef', 'reviews', 'verdict', 'dependsOn', 'note']) {
      if (item[key] !== undefined) next[key] = item[key];
    }
    if (next.role !== 'reviewer' && (next.verdict || next.reviews || next.reviewedRef)) fail('PACKAGE', '只有 reviewer 包可带 verdict/reviews/reviewedRef');
    // 已交付或已消费的包重新派发即一轮返修；attempts 由插件计数，不采信输入。
    if (previous && previous.status !== 'dispatched' && next.status === 'dispatched') next.attempts = (previous.attempts || 0) + 1;
    task.packages[item.packageId] = next;
    if (next.attempts > REPAIR_LIMIT) repairLimit.push(item.packageId);
  }
  return repairLimit;
}
// 门禁只核对 Lead 声明记录的一致性；插件看不到 Worker 真实产出，不证明审查或测试真实发生。
export function gateMissing(state, task, finalRef) {
  const missing = [];
  for (const child of Object.values(state.tasks)) {
    if (child.projectId === task.projectId && child.parentTaskId === task.taskId && child.lifecycle === 'active') missing.push(`child:${child.taskId}`);
  }
  if (task.route !== 'delegated') return missing;
  const packages = Object.values(task.packages || {});
  for (const item of packages) if (!TERMINAL_PACKAGE.includes(item.status)) missing.push(`terminal:${item.packageId}`);
  for (const worker of packages.filter(item => item.role === 'worker' && !['canceled', 'waived'].includes(item.status))) {
    const passed = packages.some(item => item.role === 'reviewer' && item.reviews === worker.packageId && item.verdict === 'PASS' && !!item.reviewedRef && item.reviewedRef === worker.deliveredRef);
    if (!passed) missing.push(`review:${worker.packageId}`);
  }
  // 验证证据必须绑定集成后的最终版本；finalRef 缺省时以 validation.ref 为准。
  if (!task.validation || (finalRef && task.validation.ref !== finalRef)) missing.push('validation');
  return missing;
}
// 豁免可写完整条目（review:pkg-1）或整类步骤（review）。
const waived = (entry, waivers) => waivers.some(w => w.step === entry || w.step === entry.split(':')[0]);
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
  let extra = {};
  if (payload.action === 'role-claim') {
    // Codeg 等委派会话与 Lead 同样触发入口事件且没有区分字段；子会话按工作包显式声明角色。
    if (!['worker', 'reviewer'].includes(payload.role)) fail('ROLE', 'role-claim 只接受 worker 或 reviewer');
    if (session.role && session.role !== payload.role) fail('ROLE', '会话已声明其他角色');
    const own = session.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
    if (own?.lifecycle === 'active') fail('ROLE', '会话有自己的活动任务，不能改为子角色');
    if (payload.packageId !== undefined) identifier(payload.packageId, 'packageId');
    session.role = payload.role;
    session.packageId = payload.packageId || null;
  } else if (session.role) {
    fail('ROLE', `当前会话已声明为 ${session.role}；业务任务和账本由 Lead 维护`);
  } else if (payload.action === 'task-start') {
    if (payload.route !== undefined && !ROUTES.includes(payload.route)) fail('ROUTE', '未知任务分流');
    if (session.taskId && session.taskId !== payload.taskId) {
      const previous = state.tasks[taskKey(project.projectId, session.taskId)];
      if (previous?.lifecycle === 'active') fail('TASK', '先明确结束当前任务，不能更换 ID 重置预算');
    }
    if (!task) {
      textField(payload.goal, 'goal');
      const permissions = payload.permissions;
      if (!permissions || !['write', 'read-only', 'plan'].includes(permissions.mode) || !Array.isArray(permissions.allowedPaths) || permissions.allowedPaths.some(p => typeof p !== 'string')) fail('PERMISSION', '任务需明确 mode 与 allowedPaths');
      task = { projectId: project.projectId, taskId: payload.taskId, goal: payload.goal, parentTaskId: payload.parentTaskId || null, route: payload.route || null, lifecycle: 'active', repairIssued: false, deliveries: {}, candidates: {}, packages: {}, permissions, createdAt: new Date().toISOString() };
      state.tasks[key] = task;
    } else {
      if (!['active', 'suspended'].includes(task.lifecycle) && !Object.values(state.pending).some(p => p.projectId === project.projectId && p.taskId === payload.taskId && p.kind === 'knowledge-pending' && p.status === 'open')) fail('TASK', '已完成任务无待接续知识');
      // 接续时可补声明分流；已声明的分流不可更改，避免中途绕过门禁。
      if (payload.route && task.route && task.route !== payload.route) fail('ROUTE', '任务已声明其他分流');
      if (payload.route) task.route = payload.route;
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
    } else if (payload.action === 'packages') {
      const repairLimit = upsertPackages(task, payload.packages);
      if (payload.validation !== undefined) task.validation = validationInput(payload.validation);
      if (repairLimit.length) extra = { repairLimit: true, repairLimitPackages: repairLimit };
    } else if (payload.action === 'task-end') {
      if (payload.validation !== undefined) task.validation = validationInput(payload.validation);
      if (payload.finalRef !== undefined) identifier(payload.finalRef, 'finalRef');
      const waivers = [...(task.waivers || []), ...(payload.waivers === undefined ? [] : waiverInput(payload.waivers))];
      const missing = gateMissing(state, task, payload.finalRef).filter(entry => !waived(entry, waivers));
      if (missing.length) {
        const error = new WorkflowError('GATE', `完成门禁未满足：${missing.join(', ')}`);
        error.missing = missing;
        throw error;
      }
      if (waivers.length) task.waivers = waivers;
      if (payload.finalRef) task.finalRef = payload.finalRef;
      task.lifecycle = 'complete';
      session.phase = 'unknown';
      if (!task.route) extra = { warning: 'route-missing' };
      else if (task.route === 'delegated') extra = { gate: 'declared-records-consistent' };
    } else if (payload.action !== 'disposition') fail('ACTION', '未知信号动作');
    if (payload.action === 'disposition' || payload.disposition) {
      if (payload.deliveryId !== session.deliveryId || !task.deliveries[payload.deliveryId]) fail('DELIVERY', '交付身份不匹配');
      if (!validDisposition(state, payload, payload.disposition)) fail('DISPOSITION', '无有效事务、理由或待办；未接受处置');
      task.deliveries[payload.deliveryId].disposition = payload.disposition;
      if (payload.disposition.status === 'updated') {
        for (const pending of Object.values(state.pending)) {
          if (pending.projectId === project.projectId && pending.taskId === task.taskId && payload.disposition.transactionIds.includes(pending.transactionId) && state.transactions[pending.transactionId]?.status === 'applied') pending.status = 'closed';
        }
      }
    }
  }
  session.revision += 1;
  session.revisionReason = `信号 ${payload.action}`;
  const result = { accepted: true, revision: session.revision, taskId: session.taskId, phase: session.phase, ...extra };
  session.receipts[payload.signalId] = { hash: digest(JSON.stringify(payload)), result };
  return result;
}
export function stop(state, project, session, event = {}) {
  // 经验采集独立于业务交付；Stop 从不启动复盘或要求补写经验。
  return {};
}
export function interrupt(state, project, session) {
  if (!session || session.interrupted) return;
  session.interruptEpoch += 1;
  session.revision += 1;
  session.revisionReason = '会话中断';
  session.ticket = null;
  session.interrupted = true;
  session.phase = 'unknown';
  const task = state.tasks[taskKey(project.projectId, session.taskId)];
  if (task?.lifecycle === 'active') {
    task.lifecycle = 'suspended';
    pendingFor(state, project.projectId, session.taskId, '业务被中断或会话结束；仅保存，不自动继续', 'business-incomplete');
  }
}
