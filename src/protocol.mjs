import path from 'node:path';
import { readFileSync } from 'node:fs';
import { deferredLifecycleEvents, digest, fail, id, lifecycleEvents, lifecycleScope, readDeferredLifecycleNote, samePath, SCHEMA_VERSION, WorkflowError } from './store.mjs';
import { checkSpecs, describeFindings, verifySpecBinding } from './spec.mjs';

export const PHASES = ['unknown', 'operation-only', 'executing', 'waiting-user', 'delivering'];
export const ROUTES = ['operation-only', 'lead-direct', 'delegated'];
export const PERMISSION_MODES = ['write', 'read-only', 'plan'];
// 宿主自己报告的只读/计划模式优先于任务声明；task-update 不能借信号绕过它。
const HOST_BLOCKED_MODES = ['plan', 'read-only'];
// task-update 只接受身份字段与 goal/permissions/allowedPathsMode；其余顶层字段明确拒绝，避免夹带 route/channels/账本。
const TASK_UPDATE_FIELDS = new Set(['schemaVersion', 'projectId', 'sessionId', 'turnId', 'taskId', 'ticket', 'interruptEpoch', 'expectedRevision', 'signalId', 'action', 'goal', 'permissions', 'allowedPathsMode']);
export const PACKAGE_STATUSES = ['dispatched', 'delivered', 'consumed', 'canceled', 'failed', 'waived'];
export const TERMINAL_PACKAGE = ['consumed', 'canceled', 'failed', 'waived'];
export const VERDICTS = ['PASS', 'FIX', 'BLOCKED'];
const REPAIR_LIMIT = 2;
const MAX_PACKAGES = 200;
const MAX_DELIVERY_REFS = 50;
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
    // 结束事件回执跨回合保留：新回合开启后旧事件重放仍然只生效一次。
    ...(session?.lifecycleReceipts ? { lifecycleReceipts: session.lifecycleReceipts } : {}),
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
    // 预检过期不是“检查不了”而是“没有按当前对象检查”，只能重试，不能豁免。
    if (step === 'spec' || step.startsWith('spec:')) fail('WAIVER', 'spec 漂移不能豁免：更新 spec，或在内容提交附 Spec-OK 写明理由；需要追认既有历史时才用空提交');
    if (step === 'spec-check:stale') fail('WAIVER', 'spec 预检已过期，不能豁免：重试 task-end 或 Stop，让当前提交与工作区重新检查');
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
// 旧账本可能只有 status=delivered/consumed 或 deliveredRef，没有 P08 新增的轮次字段。
// 在状态被改写前补记交付事实；r1 的 countedRepair 令牌迁移为 countedRound；历史 attempts 保持原值。
// 只有缺少 deliverySeq 字段的旧记录才按状态推断：新账本明确记 0 轮（启动失败或没有引用的 consumed）不得补成第 1 轮。
function backfillDelivery(item) {
  if (!item) return item;
  const legacy = item.deliverySeq === undefined;
  if (item.countedRound === undefined && Array.isArray(item.countedRepair)) {
    const counted = item.countedRepair
      .map(token => /:delivery:(\d+)$/.exec(token))
      .filter(Boolean)
      .map(match => Number(match[1]));
    // 只有 ref/FIX 令牌说明 r1 计过一轮（FIX 作为隐含交付），按已计入一轮处理。
    item.countedRound = counted.length ? Math.max(...counted) : item.countedRepair.length ? Math.max(item.deliverySeq || 0, 1) : 0;
    item.deliverySeq = Math.max(item.deliverySeq || 0, item.countedRound);
    delete item.countedRepair;
  }
  if (!legacy) {
    if (item.countedRound === undefined) item.countedRound = 0;
    return item;
  }
  if (!['delivered', 'consumed'].includes(item.status) && !item.deliveredRef && !item.deliveredAt && !item.countedRound) return item;
  if (!item.deliveredAt) item.deliveredAt = new Date().toISOString();
  item.deliverySeq = Math.max(item.deliverySeq || 0, 1);
  if (item.countedRound === undefined) item.countedRound = 0;
  // 旧记录已有的引用就是推断出的这一轮的引用，避免后续把同一引用当成迟到补记再开一轮。
  if (item.roundRef === undefined && item.deliveredRef) item.roundRef = item.deliveredRef;
  return item;
}
// 返修计数的单位是“交付轮次”，不是交付/引用/FIX 各自独立的令牌。
// 开启新一轮：进入 delivered；最近一轮还没有引用时，新出现的 deliveredRef 归入该轮（无论是否已计入）；
// 最近一轮已有别的引用或此前从未开启轮次时，新引用开启新的一轮；已见过的引用不再开启。
// roundRef 记录最近一轮的交付引用，null 表示该轮尚未登记引用；已计入的轮次记在 countedRound。
// 从非 delivered 状态直接进入 consumed 且没有新引用是消费失败或终态结果，不开启新轮次。
// 只有审查 FIX、此前没有任何交付轮次时，才由隐含交付开启第 1 轮。
function deliveryRound(previous, item, { ref = null, fixRequested = false } = {}) {
  let seq = previous?.deliverySeq || 0;
  const seen = new Set(previous?.deliveryRefs || []);
  if (previous?.deliveredRef) seen.add(previous.deliveredRef);
  let roundRef = previous?.roundRef ?? null;
  if (!previous) {
    // 新包直接以交付状态或交付引用建账，本身就是一轮。
    if (['delivered', 'consumed'].includes(item.status) || ref) { seq = 1; roundRef = ref; }
  } else if (item.status === 'delivered' && previous.status !== 'delivered') {
    // 进入 delivered 一定开新轮；本轮是否带引用都不继承上一轮的 roundRef。
    seq += 1;
    roundRef = ref;
  } else if (ref && !seen.has(ref)) {
    // 最近一轮已开启且还没有引用：迟到补记归入该轮；已有引用或从未开启轮次才开新轮。
    if (seq === 0 || roundRef) seq += 1;
    roundRef = ref;
  }
  if (fixRequested && seq === 0) { seq = 1; roundRef = null; }
  return { seq, roundRef };
}
// 记录见过的交付引用，供“此前未见过的 deliveredRef”判断；有界保留，避免状态无界增长。
function rememberDeliveryRefs(previous, next) {
  const refs = new Set(previous?.deliveryRefs || []);
  if (previous?.deliveredRef) refs.add(previous.deliveredRef);
  if (next.deliveredRef) refs.add(next.deliveredRef);
  if (refs.size) next.deliveryRefs = [...refs].slice(-MAX_DELIVERY_REFS);
}
// 本批 reviewer 事实按整批合并后的最终状态预扫 FIX 目标，保证计数与数组顺序无关。
// 先把旧账本中的 FIX 放进结果，再用本批 reviewer 项覆盖：改成 PASS/BLOCKED 或换审查对象会移除旧目标。
function batchReviewerFixes(items, task) {
  const final = new Map();
  const add = (target, reviewerId) => {
    if (!final.has(target)) final.set(target, new Set());
    final.get(target).add(reviewerId);
  };
  const remove = (target, reviewerId) => {
    const set = final.get(target);
    if (!set) return;
    set.delete(reviewerId);
    if (!set.size) final.delete(target);
  };
  for (const reviewer of Object.values(task.packages || {})) {
    if (reviewer.role === 'reviewer' && reviewer.reviews && reviewer.verdict === 'FIX') add(reviewer.reviews, reviewer.packageId);
  }
  // 同一批里同一 reviewer 重复出现时，后项覆盖前项，只按最终状态计入。
  const merged = new Map();
  for (const item of items) {
    const previous = merged.get(item.packageId) || task.packages[item.packageId];
    merged.set(item.packageId, {
      role: item.role ?? previous?.role,
      reviews: item.reviews !== undefined ? item.reviews : previous?.reviews,
      verdict: item.verdict !== undefined ? item.verdict : previous?.verdict,
    });
  }
  for (const [reviewerId, state] of merged) {
    const before = task.packages[reviewerId];
    if (before?.role === 'reviewer' && before.reviews && before.verdict === 'FIX') remove(before.reviews, reviewerId);
    if (state.role === 'reviewer' && state.reviews && state.verdict === 'FIX') add(state.reviews, reviewerId);
  }
  return final;
}
// 包本身或它沿 supersedes 接替过的旧包有过审查结论（verdict），即算已审；取消、失败而没给结论的审查包不算。
function wasReviewed(task, item) {
  const packages = task.packages || {};
  for (let current = item, hops = 0; current && hops <= MAX_PACKAGES; current = packages[current.supersedes], hops++) {
    if (Object.values(packages).some(p => p.role === 'reviewer' && p.reviews === current.packageId && p.verdict)) return true;
  }
  return false;
}
// 只有 PASS 才让 worker 包“已通过审查”；FIX/BLOCKED 与取消而无结论的审查不算。
function chainHasPass(task, item, passTargets) {
  const packages = task.packages || {};
  for (let current = item, hops = 0; current && hops <= MAX_PACKAGES; current = packages[current.supersedes], hops++) {
    if (passTargets.has(current.packageId)) return true;
  }
  return false;
}
function passTargetsOf(task) {
  return new Set(Object.values(task.packages || {}).filter(p => p.role === 'reviewer' && p.reviews && p.verdict === 'PASS').map(p => p.reviews));
}
// 只读诊断免审：只能在首次创建 worker 包时声明；用途、只读范围与非空理由缺一不可。
// 结论在交付时写在 note 里，门禁只核对它非空，不证明进程真的没有写入（信任边界）。
const DIAGNOSTIC_FIELDS = ['purpose', 'scope', 'reason'];
function diagnosticText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) fail('PACKAGE', `diagnostic 缺少或无效字段 ${label}`);
  return value.trim();
}
function diagnosticInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PACKAGE', 'diagnostic 需为 {purpose, scope[], reason}');
  const unknown = Object.keys(value).filter(key => !DIAGNOSTIC_FIELDS.includes(key));
  if (unknown.length) fail('PACKAGE', `diagnostic 不支持字段 ${unknown.join('、')}`);
  if (!Array.isArray(value.scope) || !value.scope.length || value.scope.length > 50) fail('PACKAGE', 'diagnostic.scope 需为 1-50 项项目内相对路径');
  const scope = value.scope.map((item, index) => {
    const relative = diagnosticText(item, `diagnostic.scope[${index}]`).replaceAll('\\', '/');
    if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) fail('PACKAGE', `diagnostic.scope 须为项目内相对路径：${item}`);
    return relative;
  });
  return { purpose: diagnosticText(value.purpose, 'diagnostic.purpose'), scope: [...new Set(scope)], reason: diagnosticText(value.reason, 'diagnostic.reason') };
}
// 整批预校验：取消/审查/诊断声明都在写入前判定，拒绝时本批不留下半成品记录。
function validateBatch(task, items) {
  const roles = new Map();
  for (const [packageId, item] of Object.entries(task.packages || {})) roles.set(packageId, item.role);
  for (const item of items) roles.set(item.packageId, item.role ?? roles.get(item.packageId));
  const reviewerState = new Map();
  for (const [packageId, item] of Object.entries(task.packages || {})) if (item.role === 'reviewer') reviewerState.set(packageId, { reviews: item.reviews, verdict: item.verdict });
  for (const item of items) {
    if (roles.get(item.packageId) !== 'reviewer') continue;
    const previous = reviewerState.get(item.packageId) || {};
    reviewerState.set(item.packageId, {
      reviews: item.reviews !== undefined ? item.reviews : previous.reviews,
      verdict: item.verdict !== undefined ? item.verdict : previous.verdict,
    });
  }
  const passTargets = new Set([...reviewerState.values()].filter(state => state.verdict === 'PASS' && state.reviews).map(state => state.reviews));
  const diagnostics = new Map();
  for (const item of items) {
    const previous = task.packages?.[item.packageId];
    const role = roles.get(item.packageId);
    if (role === 'reviewer') {
      const next = { ...previous, ...item };
      const verdict = next.verdict ?? null;
      if (verdict && !next.reviews) fail('PACKAGE', `审查包 ${item.packageId} 给出 ${verdict} 结论时必须用 reviews 指向被审 worker 包`);
      if (next.reviews !== undefined && next.reviews !== null) {
        if (!roles.has(next.reviews)) fail('PACKAGE', `审查包 ${item.packageId} 的 reviews 指向未登记的工作包：${next.reviews}`);
        if (roles.get(next.reviews) !== 'worker') fail('PACKAGE', `审查对象错误：reviews 须指向 worker 包，${next.reviews} 是 ${roles.get(next.reviews) || '未登记'}`);
      }
      if (verdict === 'PASS' && !next.reviewedRef) fail('PACKAGE', `PASS 审查包 ${item.packageId} 缺少 reviewedRef：PASS 必须绑定被审交付版本`);
    }
    if (role === 'worker' && item.status === 'canceled' && previous?.status !== 'canceled' && chainHasPass(task, previous, passTargets)) {
      fail('PACKAGE', `工作包 ${item.packageId} 已有 PASS 审查，不能改 canceled 退出审查门禁：让审查对上最终交付版本，或用 supersedes 接替`);
    }
    if (item.diagnostic !== undefined) {
      const parsed = diagnosticInput(item.diagnostic);
      diagnostics.set(item, parsed);
      if (previous) {
        if (!previous.diagnostic || JSON.stringify(previous.diagnostic) !== JSON.stringify(parsed)) fail('PACKAGE', 'diagnostic 只能在首次创建包时声明，不能事后补挂或修改');
      } else {
        if (role !== 'worker') fail('PACKAGE', 'diagnostic 只能用于 worker 只读诊断包，不能用于审查包或实现包');
        if (item.status !== 'dispatched') fail('PACKAGE', 'diagnostic 只能用于首次派发的只读诊断包，不能在建包时已交付或已终止');
        if (item.deliveredRef !== undefined) fail('PACKAGE', 'diagnostic 只读诊断包不能在建包时带 deliveredRef；实现包需要正常审查');
        if (item.supersedes !== undefined) fail('PACKAGE', 'diagnostic 不能接替已有工作包；接替实现包会绕过原审查');
      }
    }
  }
  return { diagnostics };
}
// 账本只在派发、消费结果、审查结论三个节点记录；批量 upsert，未给出的字段保持原值。
export function upsertPackages(task, items, change = null) {
  if (!Array.isArray(items) || !items.length || items.length > 50) fail('PACKAGE', 'packages 需为 1-50 项数组');
  task.packages ||= {};
  const repairLimit = [];
  const parsed = items.map(packageInput);
  const { diagnostics } = validateBatch(task, parsed);
  const reviewerFixes = batchReviewerFixes(parsed, task);
  const fixRequested = packageId => (reviewerFixes.get(packageId)?.size || 0) > 0;
  for (const item of parsed) {
    const previous = task.packages[item.packageId];
    // 先按旧状态补记交付事实，再做任何状态改写：旧账本的 delivered/consumed 不会因转 failed/canceled 丢失。
    backfillDelivery(previous);
    if (!previous && (!item.role || !item.status)) fail('PACKAGE', '新工作包需给出 role 与 status');
    if (!previous && Object.keys(task.packages).length >= MAX_PACKAGES) fail('PACKAGE', '工作包数量超过上限');
    if (previous && item.supersedes !== undefined && item.supersedes !== previous.supersedes) fail('PACKAGE', 'supersedes 只能在新建工作包时声明');
    if (previous?.supersededBy && item.status !== undefined && item.status !== previous.status) fail('PACKAGE', `工作包 ${previous.packageId} 已被 ${previous.supersededBy} 接替，不能再改状态`);
    const next = { attempts: 0, dependsOn: [], ...previous, packageId: item.packageId };
    for (const key of ['role', 'status', 'handle', 'channel', 'worktree', 'baseRef', 'deliveredRef', 'reviewedRef', 'reviews', 'verdict', 'dependsOn', 'note', 'supersedes']) {
      if (item[key] !== undefined) next[key] = item[key];
    }
    if (item.diagnostic !== undefined) next.diagnostic = diagnostics.get(item);
    if (next.role !== 'reviewer' && (next.verdict || next.reviews || next.reviewedRef)) fail('PACKAGE', '只有 reviewer 包可带 verdict/reviews/reviewedRef');
    // 审过的 worker 包不能改标 waived 绕过审查；放弃用 canceled，返修用 supersedes 或原包重新派发。
    if (next.role === 'worker' && next.status === 'waived' && previous?.status !== 'waived' && wasReviewed(task, next)) fail('PACKAGE', `工作包 ${next.packageId} 已有审查结论，不能标 waived：让审查对上最终交付版本，或用 supersedes 接替，或 canceled 放弃`);
    // 只有本次信号显式给出的 deliveredRef 才参与开轮；继承来的旧引用不能当成新交付。
    const incomingRef = item.deliveredRef === undefined ? null : item.deliveredRef;
    // 返修计数的单位是交付轮次：先推进轮次，再判断重派或接替时是否有尚未计入的一轮。
    if (!previous && next.supersedes) {
      const old = task.packages[next.supersedes];
      if (!old || old.role !== next.role) fail('PACKAGE', `supersedes 须指向同角色的已有工作包：${next.supersedes}`);
      if (old.supersededBy) fail('PACKAGE', `工作包 ${old.packageId} 已被 ${old.supersededBy} 接替`);
      backfillDelivery(old);
      // 旧包确有尚未计入的交付轮次（或仅 FIX 的隐含交付）时，这次接替才是一轮返修；未产出的启动失败不增加。
      const oldSeq = Math.max(old.deliverySeq || 0, fixRequested(old.packageId) ? 1 : 0);
      const oldCounted = old.countedRound || 0;
      next.attempts = (old.attempts || 0) + (oldSeq > oldCounted ? 1 : 0);
      // 新包继承旧包的轮次编号、当前轮引用与已计入标记，再叠加自己的初始交付；同一条交付不会被重复计数。
      const chain = { status: old.status, deliveredRef: old.deliveredRef, deliverySeq: oldSeq, roundRef: old.roundRef ?? null, deliveryRefs: old.deliveryRefs || [] };
      next.countedRound = Math.max(oldCounted, oldSeq);
      const planned = deliveryRound(chain, next, { ref: incomingRef, fixRequested: fixRequested(next.packageId) });
      next.deliverySeq = planned.seq;
      next.roundRef = planned.roundRef;
      rememberDeliveryRefs(chain, next);
      old.supersededBy = next.packageId;
      if (!TERMINAL_PACKAGE.includes(old.status)) old.status = old.status === 'dispatched' ? 'canceled' : 'consumed';
    } else if (previous) {
      const planned = deliveryRound(previous, next, { ref: incomingRef, fixRequested: fixRequested(next.packageId) });
      next.deliverySeq = planned.seq;
      next.roundRef = planned.roundRef;
      next.countedRound = previous.countedRound || 0;
      rememberDeliveryRefs(previous, next);
      // 同包重派：只有存在尚未计入的交付轮次才加一；已计入的轮次不会因启动失败重派再次生效。
      // attempts 由插件计数，不采信输入。
      if (previous.status !== 'dispatched' && next.status === 'dispatched') {
        if (next.deliverySeq > next.countedRound) {
          next.attempts = (previous.attempts || 0) + 1;
          next.countedRound = next.deliverySeq;
        } else next.attempts = previous.attempts || 0;
      }
    } else {
      const planned = deliveryRound(null, next, { ref: incomingRef, fixRequested: fixRequested(next.packageId) });
      next.deliverySeq = planned.seq;
      next.roundRef = planned.roundRef;
      next.countedRound = 0;
      rememberDeliveryRefs(null, next);
    }
    // 只有真正开启交付轮次时才记交付起点；启动失败或没有引用的 consumed 保持 0 轮，避免下次被旧账本回填成第 1 轮。
    if (!next.deliveredAt && next.deliverySeq > 0 && (incomingRef || next.status === 'delivered' || next.status === 'consumed')) next.deliveredAt = new Date().toISOString();
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
// root 为可信调用方给出的当前 worktree；缺省回落到项目主根。
export function unchangedPlans(state, task, root) {
  root ||= state.projects[task.projectId]?.root;
  if (!root || !task.plans?.length) return [];
  return task.plans.filter(plan => plan.digest && fileDigest(root, plan.path) === plan.digest).map(plan => plan.path);
}
const planReminder = paths => `关联计划 ${paths.join('、')} 自任务开始后没有改动：按 Lead 指引回写本任务完成的条目、偏离和剩余事项；确实不需要回写时在交付说明里写明理由。计划已全部完成时提议归档。`;
// 门禁只核对 Lead 声明记录的一致性；插件看不到 Worker 真实产出，不证明审查或测试真实发生。
export function gateMissing(state, task, finalRef, root, spec) {
  return gateReport(state, task, finalRef, root, spec).missing;
}
// spec 检查对 lead-direct、delegated 和未声明 route 的旧任务都生效；项目没有 .spec 时跳过。
// root 是 resolveProject 给出的当前 worktree，而不是 project.root，避免附加 worktree 的 drift 被主树漏掉。
// spec 是生产 Hook 在状态锁外预检的内部结果 {root, ref, projectId, taskId, report, binding, scope?}：
// - 省略（undefined）：直接调用协议函数的路径，保持在此调用内同步检查；
// - 提供但 root/ref/任务/项目不匹配，或只有 skipped 标记：按 spec-check:stale 处理，绝不复用旧结果；
// - 匹配且报告可能放行（ok:true）：binding 必须复核通过——目标提交 OID 与 HEAD 工作区仍是预检时的对象；
//   没有 binding、ref 已移动、受管文件或索引已变化都按过期处理。已带发现的报告本来就会挡下门禁，保守复用。
// - 匹配：使用该报告，不再发起 Git 调用。
const staleSpec = { missing: ['spec-check:stale'], findings: [] };
function selectSpec(spec, root, ref, task) {
  if (spec === undefined) return null;
  const matches = spec?.report && root && spec.root && samePath(spec.root, root)
    && (spec.ref ?? null) === (ref ?? null)
    && spec.projectId === task.projectId
    && spec.taskId === task.taskId;
  if (!matches) return undefined;
  if (spec.report.ok === true && !verifySpecBinding(root, spec.binding, ref ?? null)) return undefined;
  return spec.report;
}
// task-end 的锁外预检还绑定会话/任务快照：回合、票据、任务或修订变化后不得复用。
// 省略 spec（直接调用协议函数）仍走调用内同步检查。
function freshPrecheck(spec, project, session) {
  if (spec === undefined) return true;
  const scope = spec?.scope;
  return !!scope && scope.projectId === project.projectId && scope.sessionId === session.sessionId
    && scope.turnId === session.turnId && scope.ticket === session.ticket
    && scope.taskId === session.taskId && scope.revision === session.revision;
}
function specMissing(state, task, finalRef, root, spec) {
  root ||= state.projects[task.projectId]?.root;
  if (task.route === 'operation-only' || !root) return { missing: [], findings: [] };
  // 门禁是日常收尾路径：非 Git 且没有 .spec 的接入项目没有版本可查，维持原有“无 spec”跳过；
  // 显式 finalRef 在 Git 内无效、或非 Git 但存在 .spec 时仍报 spec-check:git。
  const selected = selectSpec(spec, root, finalRef, task);
  if (selected === undefined) return staleSpec;
  const report = selected ?? checkSpecs(root, { ref: finalRef || undefined, skipNonGitNoSpec: true });
  const missing = [...new Set(report.findings.map(f => `spec:${f.id}`))];
  if (report.error) missing.push(`spec-check:${report.error}`);
  return { missing, findings: report.findings };
}
export function gateReport(state, task, finalRef, root, spec) {
  const missing = [];
  for (const child of Object.values(state.tasks)) {
    if (child.projectId === task.projectId && child.parentTaskId === task.taskId && child.lifecycle === 'active') missing.push(`child:${child.taskId}`);
  }
  const specResult = specMissing(state, task, finalRef, root, spec);
  if (task.route !== 'delegated') return { missing: [...missing, ...specResult.missing], findings: specResult.findings, diagnostic: [] };
  const packages = Object.values(task.packages || {});
  for (const item of packages) if (!TERMINAL_PACKAGE.includes(item.status)) missing.push(`terminal:${item.packageId}`);
  const passTargets = passTargetsOf(task);
  const diagnostic = [];
  // 已 PASS 的 worker 包即使历史记录里被标成 canceled，也不能因此退出审查；未审取消照旧放行。
  for (const worker of packages.filter(item => item.role === 'worker' && item.status !== 'waived' && !item.supersededBy)) {
    if (worker.status === 'canceled' && !chainHasPass(task, worker, passTargets)) continue;
    if (worker.diagnostic) {
      // 只读诊断免审只按事先声明放行；交付结论必须写在 note 里，可定位但插件不验证内容真实性。
      if (!worker.note?.trim()) missing.push(`diagnostic:${worker.packageId}`);
      else diagnostic.push(worker.packageId);
      continue;
    }
    const passed = packages.some(item => item.role === 'reviewer' && item.reviews === worker.packageId && item.verdict === 'PASS' && !!item.reviewedRef && item.reviewedRef === worker.deliveredRef);
    if (!passed) missing.push(`review:${worker.packageId}`);
  }
  // 验证证据必须绑定集成后的最终版本；finalRef 缺省时以 validation.ref 为准。
  if (!task.validation || (finalRef && task.validation.ref !== finalRef)) missing.push('validation');
  return { missing: [...missing, ...specResult.missing], findings: specResult.findings, diagnostic };
}
// 豁免可写完整条目（review:pkg-1）或整类步骤（review）；spec 漂移任何豁免都不抵扣。
// 审过的 worker 包，审查缺项（未 PASS 或审的不是最终交付版本）也不抵扣：只能补审或用 supersedes 接替。
// 预检过期（spec-check:stale）不属于“检查不了”，只能重试；类别 spec-check 的旧豁免也不能抵扣它。
const reviewed = (task, entry) => entry.startsWith('review:') && wasReviewed(task, task.packages?.[entry.slice('review:'.length)]);
// diagnostic:<id> 是只读诊断包的交付结论缺项：必须补结论，不能用 waiver 抵扣。
const waived = (task, entry, waivers) => !(entry === 'spec' || entry.startsWith('spec:') || entry === 'spec-check:stale' || entry.startsWith('diagnostic:'))
  && !reviewed(task, entry) && waivers.some(w => w.step === entry || w.step === entry.split(':')[0]);
// task-update：同任务显式改 goal 与 permissions。沿用同一身份/修订/回执与失败回滚；
// 只改本机任务声明，不碰 route/channels/账本，也不改宿主全局配置。调用方须已有用户授权，插件只记录声明。
function updateTask(payload, task, session) {
  const misplaced = ['mode', 'allowedPaths'].filter(field => Object.hasOwn(payload, field));
  if (misplaced.length) fail('PERMISSION', `${misplaced.join('、')} 应放进 permissions；task-update 格式为 {goal?, permissions:{mode?, allowedPaths?}, allowedPathsMode?}`);
  const unsupported = Object.keys(payload).filter(field => !TASK_UPDATE_FIELDS.has(field));
  if (unsupported.length) fail('UNSUPPORTED', `task-update 首版只改 goal 与 permissions；不支持 ${unsupported.join('、')}`);
  const hasGoal = payload.goal !== undefined;
  const hasPermissions = payload.permissions !== undefined;
  if (!hasGoal && !hasPermissions) fail('INPUT', 'task-update 至少给出 goal 或 permissions');
  if (!task.permissions || typeof task.permissions !== 'object' || !Array.isArray(task.permissions.allowedPaths)) fail('PERMISSION', '任务缺少可更新的权限声明');
  const previous = { goal: task.goal, mode: task.permissions.mode, allowedPaths: [...task.permissions.allowedPaths] };
  let goal;
  if (hasGoal) { textField(payload.goal, 'goal'); goal = payload.goal; }
  let mode, paths, pathsMode = 'replace';
  if (hasPermissions) {
    const input = payload.permissions;
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PERMISSION', 'permissions 需为 {mode?, allowedPaths?}');
    const unknown = Object.keys(input).filter(key => !['mode', 'allowedPaths'].includes(key));
    if (unknown.length) fail('UNSUPPORTED', `permissions 只支持 mode 与 allowedPaths；不支持 ${unknown.join('、')}`);
    if (input.mode === undefined && input.allowedPaths === undefined) fail('PERMISSION', 'permissions 至少给出 mode 或 allowedPaths');
    if (input.mode !== undefined) {
      if (!PERMISSION_MODES.includes(input.mode)) fail('PERMISSION', 'permissions.mode 须为 write、read-only 或 plan');
      mode = input.mode;
    }
    if (input.allowedPaths !== undefined) {
      if (!Array.isArray(input.allowedPaths) || input.allowedPaths.some(item => typeof item !== 'string' || !item.trim())) fail('PERMISSION', 'permissions.allowedPaths 须为非空字符串数组');
      paths = input.allowedPaths;
    }
  }
  if (payload.allowedPathsMode !== undefined) {
    if (paths === undefined) fail('INPUT', 'allowedPathsMode 需与 permissions.allowedPaths 一起使用');
    if (!['replace', 'append'].includes(payload.allowedPathsMode)) fail('INPUT', 'allowedPathsMode 只能是 replace 或 append');
    pathsMode = payload.allowedPathsMode;
  }
  const nextMode = mode ?? previous.mode;
  let nextPaths = previous.allowedPaths;
  let added = [], removed = [];
  if (paths !== undefined) {
    const unique = [...new Set(paths)];
    const existing = new Set(previous.allowedPaths);
    added = unique.filter(item => !existing.has(item));
    if (pathsMode === 'append') nextPaths = [...previous.allowedPaths, ...added];
    else {
      const keep = new Set(unique);
      removed = previous.allowedPaths.filter(item => !keep.has(item));
      nextPaths = unique;
    }
  }
  // 宿主只读/计划模式优先：信号只能记录声明，不能把实际写入权限抬到宿主之上。
  if (HOST_BLOCKED_MODES.includes(session.permissionMode) && ((nextMode === 'write' && previous.mode !== 'write') || added.length)) {
    fail('PERMISSION', `宿主当前为 ${session.permissionMode} 模式：task-update 不能提升宿主权限；回到可写模式后再更新`);
  }
  if (goal !== undefined) task.goal = goal;
  if (hasPermissions) task.permissions = { ...task.permissions, ...(mode !== undefined ? { mode } : {}), ...(paths !== undefined ? { allowedPaths: nextPaths } : {}) };
  const change = {};
  if (goal !== undefined) change.goal = { from: previous.goal, to: goal };
  if (hasPermissions) {
    const permissions = {};
    if (mode !== undefined && mode !== previous.mode) permissions.mode = { from: previous.mode, to: mode };
    if (paths !== undefined) permissions.allowedPaths = { mode: pathsMode, added, removed };
    if (Object.keys(permissions).length) change.permissions = permissions;
  }
  // 追加审计记录，不修改既有会话回执；旧任务没有 updates 字段按空处理。
  if (Object.keys(change).length) (task.updates ||= []).push({ at: new Date().toISOString(), change });
  return {
    goal: task.goal,
    permissions: { ...task.permissions, allowedPaths: [...task.permissions.allowedPaths] },
    change,
    hostPermissionMode: session.permissionMode,
    note: '已更新本机任务声明；实际写入仍受宿主当前只读/计划权限约束，插件只记录声明，不自动证明用户授权真实存在',
  };
}
// options.root 只接受入口用 resolveProject 核对过的当前 worktree；payload 里的路径不参与检查根选择。
// 本函数就地修改 state，且可能在门禁拒绝前已写入部分字段（例如 task.validation）。协议函数不自行回滚；
// 调用方必须提供事务边界：生产 Hook 在调用前克隆，捕获错误后整体恢复再返回拒绝回执。
export function acceptSignal(state, payload, { root, spec } = {}) {
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
      // 新任务必须显式声明分流，避免漏填时静默绕过 delegated 门禁；旧任务没有 route 字段时按续接兼容。
      if (payload.route === undefined) fail('ROUTE', '新任务必须显式声明 route（operation-only、lead-direct 或 delegated）');
      // 新任务三项必填，缺哪项直接点名；mode 写在顶层而非 permissions 里也指出来。
      if (typeof payload.goal !== 'string' || !payload.goal.trim()) fail('INPUT', '新任务缺少 goal（一句话目标，顶层字段）；完整格式：{action:"task-start", taskId, goal, route, permissions:{mode:"write|read-only|plan", allowedPaths:[...]}}');
      textField(payload.goal, 'goal');
      const permissions = payload.permissions;
      if (!permissions || !PERMISSION_MODES.includes(permissions.mode) || !Array.isArray(permissions.allowedPaths) || permissions.allowedPaths.some(p => typeof p !== 'string')) {
        const misplaced = ['mode', 'allowedPaths'].filter(field => Object.hasOwn(payload, field));
        const detail = !permissions ? '缺少 permissions 对象' : !PERMISSION_MODES.includes(permissions.mode) ? 'permissions.mode 须为 write、read-only 或 plan' : 'permissions.allowedPaths 须为字符串数组（可为空数组）';
        fail('PERMISSION', `任务需明确 mode 与 allowedPaths：${detail}${misplaced.length ? `；${misplaced.join('、')} 写在了顶层，应放进 permissions` : ''}`);
      }
      const plans = payload.plans === undefined ? null : planInput(payload.plans);
      const channels = payload.channels === undefined ? null : channelsInput(payload.channels);
      task = { projectId: project.projectId, taskId: payload.taskId, goal: payload.goal, parentTaskId: payload.parentTaskId || null, route: payload.route || null, lifecycle: 'active', repairIssued: false, deliveries: {}, candidates: {}, packages: {}, permissions, createdAt: new Date().toISOString() };
      if (plans) task.plans = planBaselines(root || project.root, plans);
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
        task.plans ||= planBaselines(root || project.root, plans);
      }
      // 通道同样只能首次或补声明：改用其他通道走 packages 的 change 记录，不改声明。
      if (payload.channels !== undefined) {
        const channels = channelsInput(payload.channels);
        if (task.channels && JSON.stringify(task.channels) !== JSON.stringify(channels)) fail('CHANNEL', '任务已声明其他通道；偏离在 packages 信号里附 change 记录');
        task.channels ||= channels;
      }
      task.lifecycle = 'active';
      // 接续保留原目标与权限；回执明确说出保留项，避免 accepted 被误解为已更新。
      // 本次附带 goal/permissions 时点名未生效，并指向 task-update。
      const ignored = ['goal', 'permissions'].filter(field => payload[field] !== undefined);
      extra = {
        kept: { goal: task.goal, permissions: { ...task.permissions } },
        note: `task-start 接续保留原 goal 与 permissions${ignored.length ? `；本次附带的 ${ignored.join('、')} 未生效` : ''}。要显式变更请用 task-update`,
      };
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
    } else if (payload.action === 'task-update') {
      extra = updateTask(payload, task, session);
    } else if (payload.action === 'task-end') {
      if (payload.validation !== undefined) task.validation = validationInput(payload.validation);
      if (payload.finalRef !== undefined) identifier(payload.finalRef, 'finalRef');
      const waivers = [...(task.waivers || []), ...(payload.waivers === undefined ? [] : waiverInput(payload.waivers))];
      // 预检的会话/任务快照不匹配时降级为不可复用；门禁随后按 spec-check:stale 处理，不拿旧报告放行。
      const checkedSpec = freshPrecheck(spec, project, session) ? spec : {};
      const report = gateReport(state, task, payload.finalRef, root, checkedSpec);
      const missing = report.missing.filter(entry => !waived(task, entry, waivers));
      if (missing.length) {
        const specText = report.findings.length ? `。spec 检查：${describeFindings(report.findings)}；更新 spec，或在内容提交附 Spec-OK 写明不需要更新的理由（需要追认既有历史时才用空提交）` : '';
        const reviewText = missing.some(entry => reviewed(task, entry)) ? '。已安排审查的包不能豁免审查缺项：让审查结论对上最终交付版本（reviewedRef=deliveredRef），或用 supersedes 接替' : '';
        const diagnosticText = missing.some(entry => entry.startsWith('diagnostic:')) ? '。只读诊断包需要交付可定位结论：在 packages 的 note 写明结论与证据；该缺项不能用 waiver 抵扣' : '';
        const error = new WorkflowError('GATE', `完成门禁未满足：${missing.join(', ')}${specText}${reviewText}${diagnosticText}`);
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
      const stale = unchangedPlans(state, task, root);
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
// 计划交付提示：一次列明分包与所用通道；已有安排（任务声明的 channels 或包上填的 channel）
// 直接沿用，Lead 直接执行的任务没有 Worker 就不问 Worker，只有真实新增的角色或通道才请用户确认。
function planDeliveryReason(task) {
  const labels = { worker: 'Worker', reviewer: 'Reviewer' };
  const arranged = [];
  for (const [role, channel] of Object.entries(task.channels || {})) arranged.push(`${labels[role] || role} 通道 ${channel}`);
  const byChannel = new Map();
  for (const item of Object.values(task.packages || {})) {
    if (!item.channel) continue;
    const ids = byChannel.get(item.channel) || [];
    ids.push(item.packageId);
    byChannel.set(item.channel, ids);
  }
  for (const [channel, ids] of byChannel) arranged.push(`包 ${ids.join('、')} 用 ${channel}`);
  const existing = arranged.length
    ? `已有明确安排直接沿用，不重复询问：${arranged.join('；')}。`
    : '目前没有已声明的 Worker/Reviewer 通道。';
  const ask = task.route === 'lead-direct'
    ? '本任务由 Lead 直接执行，没有 Worker，不需要询问 Worker；只有计划里真实新增 Reviewer 或其他角色/通道且尚无明确安排时，才请用户确认。'
    : '只有计划里真实新增的角色或通道且尚无明确安排时，才请用户确认；上面已有的安排不要重复询问。';
  return `workflow 计划交付核对：本回合已进入计划交付但尚未向用户提问确认。若本回合在交付计划，请列出建议分流与工作包划分（分几个包、每包范围与依赖，或说明免拆包理由），一次列明各包所用通道。${existing}${ask}并在计划末尾写明 spec 影响（无影响写“无”）；结构化提问工具会自动记 waiting-user，文本提问先发 signal phase --phase waiting-user。若本回合只是回答讨论而非交付计划，直接回复即可（本回合不再重复阻挡）。`;
}
// 回合结束核对：Lead 没发 task-end 就收尾时，按门禁算一次缺项并挡下一轮。只读任务状态，只在 session 上记“本回合已挡”。
// 经验采集独立于业务交付；Stop 从不启动复盘或要求补写经验。
export function stop(state, project, session, event = {}, { root, spec } = {}) {
  if (!session || session.role || session.interrupted) return {};
  if (event.stop_hook_active === true || session.stopBlockedTurn === session.turnId) return {};
  // 提问等待用户、本回合声明为纯操作时不核对。
  if (['waiting-user', 'operation-only'].includes(session.phase)) return {};
  const task = session.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
  if (!task || task.lifecycle !== 'active' || task.route === 'operation-only') return {};
  // 只认本回合显式进入任务阶段（task-start/phase；session.phase 不跨回合继承）。
  // 历史 task.plans 不代表本回合在交付计划，普通解释不因 mode=plan 单独阻挡，也不扫描自然语言猜测意图。
  const planDelivery = session.phase !== 'unknown';
  const planning = session.permissionMode === 'plan' || task.permissions?.mode === 'plan';
  // 有包在途也挡一次：Codeg 等宿主不会在子任务结束时唤醒父会话，Lead 收尾就再也收不到结果。
  const inflight = Object.entries(task.packages || {}).filter(([, item]) => item.status === 'dispatched');
  // 计划交付核对与在途包同时成立时仍只挡一次，reason 合并两者并在途优先，避免首次提示漏掉在途结果。
  if ((planDelivery && planning) || inflight.length) {
    session.stopBlockedTurn = session.turnId;
    let reason = '';
    if (inflight.length) {
      const list = inflight.map(([id, item]) => item.handle ? `${id}(${item.handle})` : id).join('、');
      // 宿主内置子代理结束时会通知父会话，只需说明在等什么；其余（Codeg 或未填通道）必须同回合阻塞等待。
      const builtin = inflight.every(([, item]) => item.channel?.startsWith('builtin:'));
      const how = builtin
        ? '这些包由宿主内置子代理执行，结束时宿主会通知本会话：向用户说明在等哪些包、结果回来后做什么，再结束回合。'
        : '宿主不会在子任务结束时唤醒本会话，结束回合就收不到结果。二选一：用阻塞等待（Codeg get_delegation_status 批量传入在途 task_id、wait_ms: 0；若 MCP 空闲超时断开而任务仍在运行则重调续等，等待期间不轮询、不跑无关命令）等到终态或 blocked_on 再收结果；或者向用户说明为什么暂停、何时由谁接续。';
      reason = `workflow 回合结束核对：任务 ${task.taskId} 仍有 ${inflight.length} 个工作包在途（${list}）。${how}`;
    }
    if (planDelivery && planning) reason = reason ? `${reason} 另：${planDeliveryReason(task)}` : planDeliveryReason(task);
    return { decision: 'block', reason };
  }
  // 计划模式的普通讨论：计划阶段无法实施，不落到通用“门禁缺项/仍为 active”阻挡，以免打断讨论。
  if (planning && !planDelivery) return {};
  // 锁外预检按会话快照绑定；回合、票据、任务或会话修订变化后，旧报告不再代表当前 Stop。
  // 没有绑定快照的预检同样不可复用；这里只降级为“不可验证”，不把旧结果当成当前结果，也绝不在锁内补跑慢 Git。
  let checkedSpec = spec;
  if (spec !== undefined) {
    const s = spec?.scope;
    const fresh = s && s.projectId === project.projectId && s.sessionId === session.sessionId && s.turnId === session.turnId
      && s.ticket === session.ticket && s.taskId === session.taskId && s.revision === session.revision;
    if (!fresh) checkedSpec = {};
  }
  let missing;
  let unconfirmed = [];
  try {
    // 没法检查（git 失败、浅克隆、预检过期）不并入可豁免的缺项；但也不能当作“已通过”。
    const report = gateReport(state, task, undefined, root, checkedSpec);
    unconfirmed = report.missing.filter(entry => entry.startsWith('spec-check:'));
    missing = report.missing.filter(entry => !entry.startsWith('spec-check:') && !waived(task, entry, task.waivers || []));
  } catch { return {}; }
  session.stopBlockedTurn = session.turnId;
  // 过期或检查失败时明确说“无法确认”，不能因为过滤了 spec-check 就报“门禁无缺项”。
  const specNote = unconfirmed.length
    ? `spec 检查无法确认（${unconfirmed.join(', ')}）：预检结果已过期或本次没有可用的检查结果；重试 Stop 或 task-end 会按当前提交与工作区重新检查，不能当作已通过。`
    : '';
  const reason = missing.length
    ? `workflow 回合结束核对：任务 ${task.taskId} 仍为 active，门禁缺项 ${missing.join(', ')}。${specNote}二选一：补齐后发 task-end；或者向用户说明哪些还没完成、下一步是什么。不要只回复“已完成”。`
    : unconfirmed.length
      ? `workflow 回合结束核对：任务 ${task.taskId} 仍为 active，门禁其余条目已齐，但${specNote}重新检查通过后再发 task-end 或结束回合。`
      : `workflow 回合结束核对：任务 ${task.taskId} 门禁已无缺项但仍为 active。工作已完成就发 task-end 结束任务；还没完成就向用户说明剩余事项。`;
  // 计划提醒附在已有的一次阻挡里，本身不新增阻挡。
  let stale = [];
  try { stale = unchangedPlans(state, task, root); } catch {}
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
  const task = session.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
  // 同一任务可能被多个 Lead 会话共用（跨会话接续）；只有没有其他仍绑定的有效 Lead 会话时才挂起。
  if (task?.lifecycle === 'active' && !otherLeadSession(state, task, session)) {
    task.lifecycle = 'suspended';
    pendingFor(state, project.projectId, session.taskId, '业务被中断或会话结束；仅保存，不自动继续', 'business-incomplete');
  }
}
// 旧状态缺字段时保守兼容：没有 interrupted 视为未中断，完全没有 ticket 字段的旧会话不因此判为无效。
function otherLeadSession(state, task, current) {
  return Object.values(state.sessions).some(item => item !== current
    && item.projectId === task.projectId && item.taskId === task.taskId
    && !item.role && !item.interrupted
    && (item.ticket !== null || !Object.hasOwn(item, 'ticket'))
    && typeof item.turnId === 'string' && item.turnId);
}
// 生命周期结束事件先落本机待处理记录，拿到状态锁后幂等消费。只认已识别的三个结束事件，
// 不把 signal 重放成新授权。事件按 project/session/可核验的宿主回合绑定：
// - 当前回合的事件：执行中断保存；
// - 旧回合的事件迟到：不打断新回合，也不丢——任务仍 active 时保留为待办，由用户显式接续；
// - 会话/项目/回合无法核验：移入 deferred/ 并给原因，后续入口按有界重试重新关联，超限后留待办或诊断。
// 消费只改内存状态；文件归档由调用方在 mutate 成功保存后执行（archiveLifecycleEvents），
// 避免状态写入失败或保存后崩溃时事件已离开扫描范围。
// 升级诊断先写进状态（note + notePending），原因文件在锁外可重试写入；写成功前提示直接带出诊断内容，
// 不要求用户去读可能尚不存在的文件。
export const LIFECYCLE_EVENTS = ['Interrupt', 'StopFailure', 'SessionEnd'];
// deferred 记录按次数和时限有界重试：首次重入立即试一次，之后按间隔，超限后不再自动重试。
const DEFER_RETRY_INTERVAL_MS = 30_000;
const DEFER_MAX_ATTEMPTS = 5;
const DEFER_MAX_AGE_MS = 10 * 60_000;
export async function consumeLifecycleEvents(directory, state, options = {}) {
  const applied = [], deferred = [], late = [], archive = [];
  const retryIntervalMs = options.retryIntervalMs ?? DEFER_RETRY_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFER_MAX_ATTEMPTS;
  const maxAgeMs = options.maxAgeMs ?? DEFER_MAX_AGE_MS;
  const now = Date.now();
  let events;
  try { events = await lifecycleEvents(directory); }
  catch (error) {
    // 待办目录本身不可读（如被同名文件占住）：保留状态维护，但如实说明待办无法消费。
    return { applied, deferred: [{ reason: 'unreadable', message: error.message }], late, archive };
  }
  let deferredEvents;
  let deferredReadable = true;
  try { deferredEvents = await deferredLifecycleEvents(directory); }
  catch (error) { deferredEvents = []; deferredReadable = false; deferred.push({ reason: 'unreadable-deferred', message: error.message }); }
  state.lifecycleDeferred ||= {};
  const entries = [
    ...events.map(item => ({ ...item, from: 'queue' })),
    ...deferredEvents.map(item => ({ ...item, from: 'deferred' })),
  ];
  // 元数据以仍存在的队列/deferred 文件为界：消费、去重归档或人工移走后不再残留，保持有界。
  // deferred/ 本次不可读时不做剪枝：否则会把仍在重试的诊断元数据（含待写正文）误删。
  if (deferredReadable) {
    const present = new Set(entries.map(item => item.name));
    for (const key of Object.keys(state.lifecycleDeferred)) if (!present.has(key)) delete state.lifecycleDeferred[key];
  }
  for (const { name, record, from } of entries) {
    if (!record || typeof record !== 'object' || record.kind !== 'lifecycle' || !LIFECYCLE_EVENTS.includes(record.event)) {
      // 无法辨认的记录保留现场，由 doctor/人工核对，不猜测删除。
      deferred.push({ name, from, reason: 'unknown-event', escalated: Boolean(state.lifecycleDeferred[name]?.escalated) });
      continue;
    }
    const meta = state.lifecycleDeferred[name];
    if (from === 'deferred' && meta?.escalated) {
      // 诊断内容以状态为准；原因文件只是可重建的副本。读不到或内容不符时重新排队写入，写成功前提示带出正文。
      const note = typeof meta.note === 'string' && meta.note ? meta.note : escalationNote(meta.reason || '关联不足', meta.attempts || 1);
      const notePending = await readDeferredLifecycleNote(directory, name) !== `${note}\n`;
      if (notePending) archive.push({ name, from: 'deferred', to: 'deferred-note', reason: note });
      if (meta.note !== note || meta.notePending !== notePending) state.lifecycleDeferred[name] = { ...meta, note, notePending };
      deferred.push({ name, from, reason: meta.reason || 'escalated', attempts: meta.attempts, escalated: true, notePending, note });
      continue;
    }
    const project = state.projects[record.projectId];
    const session = state.sessions[sessionKey(record.projectId, record.sessionId)];
    // 没有宿主可信回合标识时不用当前会话回合推断：旧事件会被误当成新回合事件执行中断。
    const reason = !project?.enabled ? '项目未启用或已移除' : !session ? '会话未登记' : !record.turnId ? '事件缺少可信回合标识' : null;
    if (reason) {
      if (from === 'queue') {
        archive.push({ name, from, to: 'deferred', reason });
        // 初始原因也写进状态：原因文件写入失败时，下一次入口据此补写，不依赖已经丢失的返回值。
        state.lifecycleDeferred[name] = { attempts: 1, firstSeenAt: new Date(now).toISOString(), lastAttemptAt: new Date(now).toISOString(), reason, note: reason, notePending: true };
        // 缺回合标识的记录不会因会话登记而变可信；有仍 active 的任务时立即留可操作待办，不中断当前回合。
        if (!record.turnId) lifecycleTaskPending(state, record, reason);
        deferred.push({ name, from, reason, attempts: 1 });
        continue;
      }
      const attempts = meta?.attempts || 1;
      const firstSeen = Date.parse(meta?.firstSeenAt) || now;
      const lastAttempt = Date.parse(meta?.lastAttemptAt) || 0;
      // 首次重入立即重试（入口登记与结束事件交错）；之后按间隔，超过次数或时限后升级诊断。
      const due = attempts < 2 || now - lastAttempt >= retryIntervalMs || now - firstSeen >= maxAgeMs;
      if (!due) {
        // 关联重试未到期，但原因文件只是可重建的副本：首次写入失败时在这里补写。
        const note = typeof meta?.note === 'string' && meta.note ? meta.note : reason;
        const notePending = await readDeferredLifecycleNote(directory, name) !== `${note}\n`;
        if (notePending) archive.push({ name, from: 'deferred', to: 'deferred-note', reason: note });
        if (meta && (meta.note !== note || meta.notePending !== notePending)) state.lifecycleDeferred[name] = { ...meta, note, notePending };
        deferred.push({ name, from, reason, attempts, ...(notePending ? { notePending: true, note } : {}) });
        continue;
      }
      const nextAttempts = attempts + 1;
      const escalated = nextAttempts >= maxAttempts || now - firstSeen >= maxAgeMs;
      if (escalated) {
        const note = escalationNote(reason, nextAttempts);
        state.lifecycleDeferred[name] = { ...meta, attempts: nextAttempts, lastAttemptAt: new Date(now).toISOString(), reason, escalated: true, escalatedAt: new Date(now).toISOString(), note, notePending: true };
        lifecycleTaskPending(state, record, reason);
        archive.push({ name, from: 'deferred', to: 'deferred-note', reason: note });
        deferred.push({ name, from, reason, attempts: nextAttempts, escalated: true, notePending: true, note });
        continue;
      }
      // 未升级：原因文本随关联状态更新；原因文件不一致或缺失时重试写入。
      const notePending = await readDeferredLifecycleNote(directory, name) !== `${reason}\n`;
      state.lifecycleDeferred[name] = { ...meta, attempts: nextAttempts, lastAttemptAt: new Date(now).toISOString(), reason, note: reason, notePending };
      if (notePending) archive.push({ name, from: 'deferred', to: 'deferred-note', reason });
      deferred.push({ name, from, reason, attempts: nextAttempts, ...(notePending ? { notePending: true, note: reason } : {}) });
      continue;
    }
    // 重放只生效一次：归档去重与消费回执共用 event+project+session+turn+宿主事件 ID 的组合作用域；
    // 旧版只按宿主事件 ID（或 event+turn）记的回执仍兼容读取，避免升级后重复生效。
    const key = lifecycleReceiptKey(record);
    if (lifecycleReceipt(session, record)) {
      archive.push({ name, from, to: 'consumed', outcome: 'duplicate' });
      delete state.lifecycleDeferred[name];
      continue;
    }
    // 事件只对"同一回合且仍是记录时那张票据"生效：会话中断后入口可能用相同 turnId 重建新票据，
    // 旧事件不能凭 turnId 撤销新票据；事件缺少票据记录时同样不推断归属。
    const ticketMatches = typeof record.ticket === 'string' && record.ticket.length > 0 && record.ticket === session.ticket;
    if (session.turnId !== record.turnId || !ticketMatches) {
      // 旧回合或旧票据迟到：不撤销新回合票据；事件记录的 taskId 仍 active 时只保存待办，不自动继续。
      session.lifecycleReceipts ||= {};
      session.lifecycleReceipts[key] = { event: record.event, turnId: record.turnId, at: new Date().toISOString(), outcome: 'late' };
      const task = record.taskId ? state.tasks[taskKey(record.projectId, record.taskId)] : null;
      if (task?.lifecycle === 'active') pendingFor(state, record.projectId, task.taskId, lateLifecycleReason(record, session), 'business-incomplete', { turnId: record.turnId, event: record.event });
      late.push({ event: record.event, turnId: record.turnId, currentTurnId: session.turnId, ticketMatched: ticketMatches });
      archive.push({ name, from, to: 'consumed', outcome: 'late' });
      delete state.lifecycleDeferred[name];
      continue;
    }
    interrupt(state, project, session);
    session.lifecycleReceipts ||= {};
    session.lifecycleReceipts[key] = { event: record.event, turnId: record.turnId, at: new Date().toISOString(), outcome: 'applied' };
    applied.push({ event: record.event, sessionId: record.sessionId, turnId: record.turnId });
    archive.push({ name, from, to: 'consumed', outcome: 'applied' });
    delete state.lifecycleDeferred[name];
  }
  return { applied, deferred, late, archive };
}
// 关联不足时给出可操作待办（仅任务仍 active），让人显式核对，而不是静默滞留或猜测中断。
const escalationNote = (reason, attempts) => `${reason}；已重试 ${attempts} 次仍无法恢复关联，不再自动重试。核对 deferred/ 中的事件，必要时人工处理`;
function lifecycleTaskPending(state, record, reason) {
  const task = record.taskId ? state.tasks[taskKey(record.projectId, record.taskId)] : null;
  if (task?.lifecycle !== 'active') return null;
  return pendingFor(state, record.projectId, task.taskId,
    `${record.event} 事件无法确认属于当前回合（${reason}）；未中断任何回合，任务 ${task.taskId} 仍为 active，请核对后显式收尾或接续`,
    'business-incomplete', { event: record.event, turnId: record.turnId || null, source: 'lifecycle-deferred' });
}
// 迟到事件的原因要说明是回合不同、票据已更换，还是事件本身没记录票据；三者都不能推断中断。
function lateLifecycleReason(record, session) {
  if (session.turnId !== record.turnId) return `${record.event} 属于回合 ${record.turnId}，晚于新回合到达；已保存，不自动继续`;
  return record.ticket
    ? `${record.event} 记录的票据与当前回合不一致（回合 ${record.turnId}）：票据在会话重建后已更换；已保存，不撤销新票据，不自动继续`
    : `${record.event} 未记录可信票据（回合 ${record.turnId}）：无法确认属于当前会话；已保存，不撤销新票据，不自动继续`;
}
// 归档去重与消费回执的同一组合作用域；旧版两种回执键只读兼容，新记录只写组合键。
function lifecycleReceiptKey(record) {
  return `scope:${lifecycleScope(record)}`;
}
function legacyLifecycleReceiptKey(record) {
  return typeof record.hostEventId === 'string' && record.hostEventId ? `event:${record.hostEventId}` : `turn:${record.event}\0${record.turnId}`;
}
function lifecycleReceipt(session, record) {
  const receipts = session.lifecycleReceipts;
  if (!receipts) return null;
  return receipts[lifecycleReceiptKey(record)] || receipts[legacyLifecycleReceiptKey(record)] || null;
}
