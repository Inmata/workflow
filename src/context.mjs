import { fail, readState } from './store.mjs';
import { PRODUCT_VERSION, cliPath, command, docPath } from './entry.mjs';
import { sessionKey, taskKey } from './protocol.mjs';
import { resolveProject } from './projects.mjs';
import { inspectAlignment } from './alignment.mjs';
import { selectKnowledge } from './learning.mjs';

export { PRODUCT_ROOT } from './entry.mjs';
// 信号只认单条直接调用；给出可照抄的模板，避免代理自拼变量、cd 或 && 组合导致信号被丢弃。
export function signalUsage(cli = cliPath()) {
  return {
    command: `node "${cli.replaceAll('\\', '/')}" signal --base64 <UTF-8 JSON 的 base64>`,
    rule: '整条命令只能是这一次直接调用：不加 cd、&&、;、管道、重定向或变量赋值（如 $wf=...）；JSON 取当前 identity 加 action、signalId 等字段。',
  };
}
// 后台学习会真实调用模型，接入不自动授权；Lead 在对齐后补问一次，并把完整命令交给用户或在授权后直接执行。
function learningNote(root, stateDir) {
  const run = args => command([...args, '--root', root], { stateDir });
  return `后台学习尚未启用、计划任务未注册：这是接入的一部分。对齐完成后向用户说明会按 learning 配置真实调用模型并消耗额度（执行器与专用配置见 backgroundReviewGuide），先运行 \`${run(['learning', 'doctor'])}\` 核对执行器；用户同意后请用户在自己的终端执行 \`${command(['project', 'onboard', '--root', root, '--enable-learning'], { stateDir })}\`（一次完成启用和计划任务注册；代理执行会被宿主自动审批拦截），原样给出这条完整命令，不改写、不只给选项。用户不需要时执行 \`${run(['learning', 'disable'])}\` 记下决定，此提示不再出现。`;
}
// 学习已启用时入口不再提学习，代理交付对齐时容易漏报或被追问时误判为未启用；给一句现状，核对以 learning status 为准。
function learningState(learning, root, stateDir) {
  const task = learning.schedule?.taskName;
  return task ? `后台复盘已启用，计划任务 ${task} 已登记：对齐交付时在总结里写明这一点；用户问起先用 learning status 和系统任务核对，不重复注册。`
    : `后台复盘已启用但计划任务未登记：请用户在自己的终端执行 \`${command(['learning', 'schedule', 'install', '--root', root], { stateDir })}\`，代理执行会被宿主自动审批拦截。`;
}
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
  if (alignment.mismatch?.length) return `对齐文档表格与本机索引不一致（${alignment.mismatch.map(m => m.id + ':' + m.document + '/' + m.index).join('、')}）：不要手改表格，按 alignmentGuide 用 decide 重新登记。`;
  if (alignment.stale) return `项目对齐索引已过期（${alignment.changed.length + alignment.missing.length + alignment.directoryChanged.length} 项变化）：只重读变化文件和新增资料，更新对齐文件，不重新全量扫描。`;
  if (alignment.pendingDecisions || alignment.pendingFindings) return `项目对齐还有 ${alignment.pendingDecisions} 项待裁决、${alignment.pendingFindings} 项结构建议；按提问路径向用户确认，可跨回合裁决；用户批准的结构建议在当回合直接执行修改，再用 decide 登记 accepted-change。`;
  return '';
}
// 每包一行，不附结果正文：压缩后据此避免重复派工和重读已消费结果。
export function compactLedger(task) {
  const packages = Object.values(task?.packages || {});
  if (!task || (!packages.length && !task.route)) return null;
  return {
    lifecycle: task.lifecycle,
    route: task.route || null,
    packages: packages.map(p => [p.packageId, p.role, p.status, p.deliveredRef || '-', p.role === 'reviewer' ? `${p.verdict || '-'}@${p.reviews || '-'}:${p.reviewedRef || '-'}` : '-', p.attempts || 0].join(' ')),
    validation: task.validation ? task.validation.ref : null,
    changes: task.changes?.length || 0,
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
  // 接入不自动授权后台维护（会真实调用模型）；Lead 在接入阶段补问一次，避免漏做。
  const learning = role !== 'lead' ? '' : project.learning?.enabled ? learningState(project.learning, project.root, options.directory)
    : !project.learning?.changedAt ? learningNote(project.root, options.directory) : '';
  let knowledge;
  if (options.directory && task?.lifecycle === 'active') {
    knowledge = await selectKnowledge(options.directory, project.root, { text: task.goal, paths: task.permissions.allowedPaths });
    const key = JSON.stringify([task.taskId, task.goal, task.permissions.allowedPaths, knowledge.version]);
    if (options.incremental && session.contextKey === key) knowledge = { unchanged: true, version: knowledge.version };
    else if (options.incremental) session.contextKey = key;
  }
  // 挂起任务（会话结束或中断后续接）也给账本，Lead 据此 task-start 续接而不重复派工。
  const ledger = role === 'lead' && ['active', 'suspended'].includes(task?.lifecycle) ? compactLedger(task) : null;
  // 有包在途时提醒：用户新消息若改变需求，走中途纠正流程，而不是只在 Lead 侧记下。
  const inflight = ledger && task.lifecycle === 'active' ? Object.values(task.packages || {}).filter(p => p.status === 'dispatched').map(p => p.packageId) : [];
  const correction = inflight.length ? `有 ${inflight.length} 个工作包在途（${inflight.join('、')}）：若本条用户消息改变需求或范围，按中途纠正流程先核对已有成果、取消并确认停止，再以新基准和用户原话重新派发。` : '';
  const instruction = [instructions[role], note, learning, correction].filter(Boolean).join(' ');
  return {
    enabled: true, projectId: project.projectId, root: project.root, worktree: resolved.worktree,
    role, documents: [docPath('workflow.md'), docPath('roles', `${role}.md`)],
    cli: cliPath(), version: PRODUCT_VERSION, signal: signalUsage(), identity,
    coexistenceMode: project.coexistenceMode, pending,
    alignment, knowledge, notices,
    ...(ledger ? { ledger } : {}),
    learningGuide: docPath('learning.md'),
    ...(role === 'lead' ? { alignmentGuide: docPath('alignment.md'), backgroundReviewGuide: docPath('background-review.md') } : {}),
    instruction,
  };
}
export async function getContext(directory, cwd, role, sessionId) {
  const state = await readState(directory);
  const resolved = await resolveProject(state, cwd);
  if (!resolved) return { enabled: false, reason: '当前目录没有有效本机绑定' };
  return projectContext(state, resolved, role, sessionId, { directory });
}
