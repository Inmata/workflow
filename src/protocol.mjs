import path from 'node:path';
import { readFileSync } from 'node:fs';
import { digest, fail, id, SCHEMA_VERSION, WorkflowError } from './store.mjs';
import { checkSpecs, describeFindings } from './spec.mjs';

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
    receipts: session?.receipts || {}, observed: session?.observed || {}, contextKey: session?.contextKey, briefed: session?.briefed,
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
  for (const key of ['baseRef', 'deliveredRef', 'reviewedRef', 'reviews', 'channel', 'supersedes']) optionalRef(item[key], key);
  return item;
}
// 派工通道：`codeg:<agent_type>` 为 Codeg 委派，`builtin:<类型>` 为宿主内置子代理，`lead` 为 Lead 自己实施。
function channelsInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(role => !['worker', 'reviewer'].includes(role))) fail('CHANNEL', 'channels 需为 {worker?, reviewer?}，值为通道名（如 codeg:claude_code、builtin:general-purpose、lead）');
  for (const [role, channel] of Object.entries(value)) identifier(channel, `channels.${role}`);
  return { ...value };
}
// 与用户指定通道不一致，或分工任务里 worker 包由 Lead 实施，都算偏离：同一信号的 change 必须列出该包，不能静默换路。
function channelDeviation(task, next) {
  const expected = task.channels?.[next.role];
  if (expected && next.channel !== expected) return `通道 ${next.channel || '未填'} 与任务声明的 ${next.role}=${expected} 不一致`;
  if (task.route === 'delegated' && next.role === 'worker' && (next.channel === 'lead' || next.handle === 'lead-direct')) return '分工任务的 worker 包改由 Lead 实施';
  return null;
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
    const step = textField(item.step, 'waiver.step');
    // spec 漂移只能更新 spec 或做 Spec-OK 空提交消除，让“不用改 spec”的判断留在 git 历史里；spec-check（没法检查）可豁免。
    if (step === 'spec' || step.startsWith('spec:')) fail('WAIVER', 'spec 漂移不能豁免：更新 spec，或用 Spec-OK 空提交写明理由');
    return { step, reason: textField(item.reason, 'waiver.reason') };
  });
}
function changeInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CHANGE', 'change 需为 {summary, reason, packages[]}');
  const packages = value.packages === undefined ? [] : value.packages;
  if (!Array.isArray(packages) || packages.length > 50) fail('CHANGE', 'change.packages 需为数组');
  packages.forEach(item => identifier(item, 'change.packages'));
  return { summary: textField(value.summary, 'change.summary'), reason: textField(value.reason, 'change.reason'), packages, at: new Date().toISOString() };
}
// 包本身或它沿 supersedes 接替过的旧包有过审查结论（verdict），即算已审；取消、失败而没给结论的审查包不算。
function wasReviewed(task, item) {
  const packages = task.packages || {};
  for (let current = item, hops = 0; current && hops <= MAX_PACKAGES; current = packages[current.supersedes], hops++) {
    if (Object.values(packages).some(p => p.role === 'reviewer' && p.reviews === current.packageId && p.verdict)) return true;
  }
  return false;
}
// 账本只在派发、消费结果、审查结论三个节点记录；批量 upsert，未给出的字段保持原值。
export function upsertPackages(task, items, change = null) {
  if (!Array.isArray(items) || !items.length || items.length > 50) fail('PACKAGE', 'packages 需为 1-50 项数组');
  task.packages ||= {};
  const repairLimit = [];
  for (const item of items.map(packageInput)) {
    const previous = task.packages[item.packageId];
    if (!previous && (!item.role || !item.status)) fail('PACKAGE', '新工作包需给出 role 与 status');
    if (!previous && Object.keys(task.packages).length >= MAX_PACKAGES) fail('PACKAGE', '工作包数量超过上限');
    if (previous && item.supersedes !== undefined && item.supersedes !== previous.supersedes) fail('PACKAGE', 'supersedes 只能在新建工作包时声明');
    if (previous?.supersededBy && item.status !== undefined && item.status !== previous.status) fail('PACKAGE', `工作包 ${previous.packageId} 已被 ${previous.supersededBy} 接替，不能再改状态`);
    const next = { attempts: 0, dependsOn: [], ...previous, packageId: item.packageId };
    for (const key of ['role', 'status', 'handle', 'channel', 'worktree', 'baseRef', 'deliveredRef', 'reviewedRef', 'reviews', 'verdict', 'dependsOn', 'note', 'supersedes']) {
      if (item[key] !== undefined) next[key] = item[key];
    }
    if (next.role !== 'reviewer' && (next.verdict || next.reviews || next.reviewedRef)) fail('PACKAGE', '只有 reviewer 包可带 verdict/reviews/reviewedRef');
    // 审过的 worker 包不能改标 waived 绕过审查；放弃用 canceled，返修用 supersedes 或原包重新派发。
    if (next.role === 'worker' && next.status === 'waived' && previous?.status !== 'waived' && wasReviewed(task, next)) fail('PACKAGE', `工作包 ${next.packageId} 已有审查结论，不能标 waived：让审查对上最终交付版本，或用 supersedes 接替，或 canceled 放弃`);
    // 已交付或已消费的包重新派发即一轮返修；attempts 由插件计数，不采信输入。
    if (previous && previous.status !== 'dispatched' && next.status === 'dispatched') next.attempts = (previous.attempts || 0) + 1;
    // 换新 packageId 返修时用 supersedes 接上旧包：继承轮次，旧包收尾，不再单独要求审查。
    if (!previous && next.supersedes) {
      const old = task.packages[next.supersedes];
      if (!old || old.role !== next.role) fail('PACKAGE', `supersedes 须指向同角色的已有工作包：${next.supersedes}`);
      if (old.supersededBy) fail('PACKAGE', `工作包 ${old.packageId} 已被 ${old.supersededBy} 接替`);
      next.attempts = (old.attempts || 0) + 1;
      old.supersededBy = next.packageId;
      if (!TERMINAL_PACKAGE.includes(old.status)) old.status = old.status === 'dispatched' ? 'canceled' : 'consumed';
    }
    // 只在通道变化或新建时核对；同一偏离已记过 change 的包，后续重新派发不再要求。
    const deviation = channelDeviation(task, next);
    if (deviation && deviation !== (previous && channelDeviation(task, previous)) && !change?.packages.includes(next.packageId)) fail('CHANNEL', `工作包 ${next.packageId}：${deviation}。先向用户说明，再在同一 packages 信号附 change:{summary, reason, packages:["${next.packageId}"]} 记录偏离`);
    task.packages[item.packageId] = next;
    if (next.attempts > REPAIR_LIMIT) repairLimit.push(item.packageId);
  }
  return repairLimit;
}
// 关联计划只作软提醒：task-start 记下计划文件摘要，结束时没变就提醒回写进度；不进 missing，不挡 task-end。
function planInput(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) fail('PLAN', 'plans 需为 1-10 项相对路径数组');
  return value.map((item, index) => {
    const relative = textField(item, `plans[${index}]`).replaceAll('\\', '/');
    if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) fail('PLAN', `计划路径须为项目内相对路径：${item}`);
    return relative;
  });
}
function fileDigest(root, relative) {
  try { return digest(readFileSync(path.join(root, relative))); } catch { return null; }
}
function planBaselines(root, plans) {
  return plans.map(relative => ({ path: relative, digest: root ? fileDigest(root, relative) : null }));
}
// 内容未变才算没回写；文件不见了按已归档或改名处理，读不到基线时不提醒。
export function unchangedPlans(state, task) {
  const root = state.projects[task.projectId]?.root;
  if (!root || !task.plans?.length) return [];
  return task.plans.filter(plan => plan.digest && fileDigest(root, plan.path) === plan.digest).map(plan => plan.path);
}
const planReminder = paths => `关联计划 ${paths.join('、')} 自任务开始后没有改动：按 Lead 指引回写本任务完成的条目、偏离和剩余事项；确实不需要回写时在交付说明里写明理由。计划已全部完成时提议归档。`;
// 门禁只核对 Lead 声明记录的一致性；插件看不到 Worker 真实产出，不证明审查或测试真实发生。
export function gateMissing(state, task, finalRef) {
  return gateReport(state, task, finalRef).missing;
}
// spec 检查对 lead-direct、delegated 和未声明 route 的旧任务都生效；项目没有 .spec 时跳过。
function specMissing(state, task, finalRef) {
  const root = state.projects[task.projectId]?.root;
  if (task.route === 'operation-only' || !root) return { missing: [], findings: [] };
  const report = checkSpecs(root, { ref: finalRef || undefined });
  const missing = [...new Set(report.findings.map(f => `spec:${f.id}`))];
  if (report.error) missing.push(`spec-check:${report.error}`);
  return { missing, findings: report.findings };
}
export function gateReport(state, task, finalRef) {
  const missing = [];
  for (const child of Object.values(state.tasks)) {
    if (child.projectId === task.projectId && child.parentTaskId === task.taskId && child.lifecycle === 'active') missing.push(`child:${child.taskId}`);
  }
  const spec = specMissing(state, task, finalRef);
  if (task.route !== 'delegated') return { missing: [...missing, ...spec.missing], findings: spec.findings };
  const packages = Object.values(task.packages || {});
  for (const item of packages) if (!TERMINAL_PACKAGE.includes(item.status)) missing.push(`terminal:${item.packageId}`);
  for (const worker of packages.filter(item => item.role === 'worker' && !['canceled', 'waived'].includes(item.status) && !item.supersededBy)) {
    const passed = packages.some(item => item.role === 'reviewer' && item.reviews === worker.packageId && item.verdict === 'PASS' && !!item.reviewedRef && item.reviewedRef === worker.deliveredRef);
    if (!passed) missing.push(`review:${worker.packageId}`);
  }
  // 验证证据必须绑定集成后的最终版本；finalRef 缺省时以 validation.ref 为准。
  if (!task.validation || (finalRef && task.validation.ref !== finalRef)) missing.push('validation');
  return { missing: [...missing, ...spec.missing], findings: spec.findings };
}
// 豁免可写完整条目（review:pkg-1）或整类步骤（review）；spec 漂移任何豁免都不抵扣。
// 审过的 worker 包，审查缺项（未 PASS 或审的不是最终交付版本）也不抵扣：只能补审或用 supersedes 接替。
const reviewed = (task, entry) => entry.startsWith('review:') && wasReviewed(task, task.packages?.[entry.slice('review:'.length)]);
const waived = (task, entry, waivers) => !(entry === 'spec' || entry.startsWith('spec:')) && !reviewed(task, entry) && waivers.some(w => w.step === entry || w.step === entry.split(':')[0]);
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
      // 新任务三项必填，缺哪项直接点名；mode 写在顶层而非 permissions 里也指出来。
      if (typeof payload.goal !== 'string' || !payload.goal.trim()) fail('INPUT', '新任务缺少 goal（一句话目标，顶层字段）；完整格式：{action:"task-start", taskId, goal, route, permissions:{mode:"write|read-only|plan", allowedPaths:[...]}}');
      textField(payload.goal, 'goal');
      const permissions = payload.permissions;
      if (!permissions || !['write', 'read-only', 'plan'].includes(permissions.mode) || !Array.isArray(permissions.allowedPaths) || permissions.allowedPaths.some(p => typeof p !== 'string')) {
        const misplaced = ['mode', 'allowedPaths'].filter(field => Object.hasOwn(payload, field));
        const detail = !permissions ? '缺少 permissions 对象' : !['write', 'read-only', 'plan'].includes(permissions.mode) ? 'permissions.mode 须为 write、read-only 或 plan' : 'permissions.allowedPaths 须为字符串数组（可为空数组）';
        fail('PERMISSION', `任务需明确 mode 与 allowedPaths：${detail}${misplaced.length ? `；${misplaced.join('、')} 写在了顶层，应放进 permissions` : ''}`);
      }
      const plans = payload.plans === undefined ? null : planInput(payload.plans);
      const channels = payload.channels === undefined ? null : channelsInput(payload.channels);
      task = { projectId: project.projectId, taskId: payload.taskId, goal: payload.goal, parentTaskId: payload.parentTaskId || null, route: payload.route || null, lifecycle: 'active', repairIssued: false, deliveries: {}, candidates: {}, packages: {}, permissions, createdAt: new Date().toISOString() };
      if (plans) task.plans = planBaselines(project.root, plans);
      if (channels) task.channels = channels;
      state.tasks[key] = task;
    } else {
      if (!['active', 'suspended'].includes(task.lifecycle) && !Object.values(state.pending).some(p => p.projectId === project.projectId && p.taskId === payload.taskId && p.kind === 'knowledge-pending' && p.status === 'open')) fail('TASK', '已完成任务无待接续知识');
      // 接续时可补声明分流；已声明的分流不可更改，避免中途绕过门禁。
      if (payload.route && task.route && task.route !== payload.route) fail('ROUTE', '任务已声明其他分流');
      if (payload.route) task.route = payload.route;
      // 计划同样只能首次或补声明；补声明时以当时内容为基线。
      if (payload.plans !== undefined) {
        const plans = planInput(payload.plans);
        if (task.plans?.length && JSON.stringify(task.plans.map(p => p.path)) !== JSON.stringify(plans)) fail('PLAN', '任务已声明其他计划');
        task.plans ||= planBaselines(project.root, plans);
      }
      // 通道同样只能首次或补声明：改用其他通道走 packages 的 change 记录，不改声明。
      if (payload.channels !== undefined) {
        const channels = channelsInput(payload.channels);
        if (task.channels && JSON.stringify(task.channels) !== JSON.stringify(channels)) fail('CHANNEL', '任务已声明其他通道；偏离在 packages 信号里附 change 记录');
        task.channels ||= channels;
      }
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
      const change = payload.change === undefined ? null : changeInput(payload.change);
      const repairLimit = upsertPackages(task, payload.packages, change);
      if (payload.validation !== undefined) task.validation = validationInput(payload.validation);
      // 中途变更追加记录，不覆盖历史。
      if (change) (task.changes ||= []).push(change);
      if (repairLimit.length) extra = { repairLimit: true, repairLimitPackages: repairLimit };
    } else if (payload.action === 'task-end') {
      if (payload.validation !== undefined) task.validation = validationInput(payload.validation);
      if (payload.finalRef !== undefined) identifier(payload.finalRef, 'finalRef');
      const waivers = [...(task.waivers || []), ...(payload.waivers === undefined ? [] : waiverInput(payload.waivers))];
      const report = gateReport(state, task, payload.finalRef);
      const missing = report.missing.filter(entry => !waived(task, entry, waivers));
      if (missing.length) {
        const specText = report.findings.length ? `。spec 检查：${describeFindings(report.findings)}；更新 spec，或用 Spec-OK 空提交写明不需要更新的理由` : '';
        const reviewText = missing.some(entry => reviewed(task, entry)) ? '。已安排审查的包不能豁免审查缺项：让审查结论对上最终交付版本（reviewedRef=deliveredRef），或用 supersedes 接替' : '';
        const error = new WorkflowError('GATE', `完成门禁未满足：${missing.join(', ')}${specText}${reviewText}`);
        error.missing = missing;
        if (report.findings.length) error.findings = report.findings;
        throw error;
      }
      if (waivers.length) task.waivers = waivers;
      if (payload.finalRef) task.finalRef = payload.finalRef;
      task.lifecycle = 'complete';
      session.phase = 'unknown';
      if (!task.route) extra = { warning: 'route-missing' };
      else if (task.route === 'delegated') extra = { gate: 'declared-records-consistent' };
      const stale = unchangedPlans(state, task);
      if (stale.length) extra = { ...extra, planUnchanged: stale, reminder: planReminder(stale) };
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
// 回合结束核对：Lead 没发 task-end 就收尾时，按门禁算一次缺项并挡下一轮。只读任务状态，只在 session 上记“本回合已挡”。
// 经验采集独立于业务交付；Stop 从不启动复盘或要求补写经验。
export function stop(state, project, session, event = {}) {
  if (!session || session.role || session.interrupted) return {};
  if (event.stop_hook_active === true || session.stopBlockedTurn === session.turnId) return {};
  // 提问等待用户、本回合声明为纯操作时不核对。
  if (['waiting-user', 'operation-only'].includes(session.phase)) return {};
  const task = session.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
  // 计划阶段没向用户提问确认分包与 Worker/Reviewer 通道就收尾时，挡一次提醒补齐（已调提问工具或发 waiting-user 的已在上方放行）。
  if (session.permissionMode === 'plan' || (task?.lifecycle === 'active' && task.permissions?.mode === 'plan')) {
    session.stopBlockedTurn = session.turnId;
    return {
      decision: 'block',
      reason: 'workflow 计划交付核对：当前处于计划阶段但尚未向用户提问确认。若本回合在交付计划，请列出建议分流与工作包划分（分几个包、每包范围与依赖，或说明免拆包理由），并按提问路径请用户指定 Worker 与 Reviewer 通道（提问工具会自动记 waiting-user，文本提问先发 signal phase --phase waiting-user）；若本回合只是回答讨论而非交付计划，直接回复即可（本回合不再重复阻挡）。',
    };
  }
  if (!task || task.lifecycle !== 'active' || task.route === 'operation-only') return {};
  // 有包在途也挡一次：Codeg 等宿主不会在子任务结束时唤醒父会话，Lead 收尾就再也收不到结果。
  const inflight = Object.entries(task.packages || {}).filter(([, item]) => item.status === 'dispatched');
  if (inflight.length) {
    session.stopBlockedTurn = session.turnId;
    const list = inflight.map(([id, item]) => item.handle ? `${id}(${item.handle})` : id).join('、');
    // 宿主内置子代理结束时会通知父会话，只需说明在等什么；其余（Codeg 或未填通道）必须同回合阻塞等待。
    const builtin = inflight.every(([, item]) => item.channel?.startsWith('builtin:'));
    const how = builtin
      ? '这些包由宿主内置子代理执行，结束时宿主会通知本会话：向用户说明在等哪些包、结果回来后做什么，再结束回合。'
      : '宿主不会在子任务结束时唤醒本会话，结束回合就收不到结果。二选一：用阻塞等待（Codeg get_delegation_status 批量传入在途 task_id、wait_ms: 0；若 MCP 空闲超时断开而任务仍在运行则重调续等，等待期间不轮询、不跑无关命令）等到终态或 blocked_on 再收结果；或者向用户说明为什么暂停、何时由谁接续。';
    return { decision: 'block', reason: `workflow 回合结束核对：任务 ${task.taskId} 仍有 ${inflight.length} 个工作包在途（${list}）。${how}` };
  }
  let missing;
  try {
    // 没法检查（git 失败、浅克隆）不算缺项；其余照常核对。
    missing = gateMissing(state, task).filter(entry => !entry.startsWith('spec-check:') && !waived(task, entry, task.waivers || []));
  } catch { return {}; }
  session.stopBlockedTurn = session.turnId;
  const reason = missing.length
    ? `workflow 回合结束核对：任务 ${task.taskId} 仍为 active，门禁缺项 ${missing.join(', ')}。二选一：补齐后发 task-end；或者向用户说明哪些还没完成、下一步是什么。不要只回复“已完成”。`
    : `workflow 回合结束核对：任务 ${task.taskId} 门禁已无缺项但仍为 active。工作已完成就发 task-end 结束任务；还没完成就向用户说明剩余事项。`;
  // 计划提醒附在已有的一次阻挡里，本身不新增阻挡。
  let stale = [];
  try { stale = unchangedPlans(state, task); } catch {}
  return { decision: 'block', reason: stale.length ? `${reason} 另：${planReminder(stale)}` : reason };
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
