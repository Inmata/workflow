import { fail, readState } from './store.mjs';
import { PRODUCT_VERSION, cliPath, command, docPath } from './entry.mjs';
import { sessionKey, taskKey } from './protocol.mjs';
import { resolveProject } from './projects.mjs';
import { inspectAlignment } from './alignment.mjs';
import { selectKnowledge } from './learning.mjs';

export { PRODUCT_ROOT } from './entry.mjs';
// 信号只认单条直接调用；给出可照抄的模板，避免代理自拼变量、cd 或 && 组合导致信号被丢弃。
// 推荐子命令写法：身份字段由 CLI 从本机状态补齐，一次调用即可，不必先写临时 JSON 文件。
// 完整 payload 用 --input；base64 长串会被宿主的密钥脱敏改写成占位符，信号随之变成无效 JSON。
export function signalUsage(cli = cliPath()) {
  const entry = cli.replaceAll('\\', '/');
  const head = `node "${entry}" signal`;
  const who = '--session <identity.sessionId> --turn <identity.turnId> --id <新 signalId>';
  return {
    command: `${head} <action> ${who} [字段参数]`,
    examples: [
      `${head} task-start ${who} --task <taskId> --route lead-direct --goal "<一句话目标>" --mode write --paths <相对路径,逗号分隔>`,
      `${head} task-update ${who} --task <taskId> [--goal "<新目标>"] [--mode write|read-only|plan] [--paths <相对路径,逗号分隔> --paths-mode replace|append]`,
      `${head} task-end ${who} [--final-ref <commit>] [--validation-ref <commit> --evidence "<证据>" --evidence "<证据>"]`,
      `${head} packages ${who} --package <packageId> --status <dispatched|delivered|consumed|canceled|failed|waived> [--role worker|reviewer] [--channel <通道>] [--handle <委派ID>] [--ref <交付/审查提交>] [--depends-on a,b] [--supersedes <旧包>] [--verdict PASS|FIX|BLOCKED --reviews <worker包>]`,
    ],
    fallback: `${head} packages ${who} --input <同批多个包或 change 的 JSON 文件>（只放业务字段）；完整 payload 兼容 ${head} --input <完整 payload 的 UTF-8 JSON 文件>（或 ${head} --base64 <...>）`,
    rule: '单独直接调用：不加 cd、&&、;、管道、重定向或变量赋值（如 $wf=...）。便捷参数只表达单个工作包，同批多个包、change 与 waivers 继续用 --input；task-end 的 validation.ref 缺省取 --final-ref。同一 signalId 重试命令保持不变。',
  };
}
// 后台学习会真实调用模型，接入不自动授权；Lead 在对齐后补问一次，并把完整命令交给用户或在授权后直接执行。
function learningNote(root, stateDir) {
  const run = args => command([...args, '--root', root], { stateDir });
  return `后台学习尚未启用、计划任务未注册：这是接入的一部分。对齐完成后向用户说明会按 learning 配置真实调用模型并消耗额度（执行器与专用配置见 backgroundReviewGuide），先运行 \`${run(['learning', 'doctor'])}\` 核对执行器；用户同意后执行 \`${command(['project', 'onboard', '--root', root, '--enable-learning'], { stateDir })}\`（一次完成启用和计划任务注册）。当前会话权限允许时可由代理直接执行，否则请用户在自己的终端执行；原样给出这条完整命令，不改写、不只给选项。用户不需要时执行 \`${run(['learning', 'disable'])}\` 记下决定，此提示不再出现。`;
}
// 学习已启用时入口不再提学习，代理交付对齐时容易漏报或被追问时误判为未启用；给一句现状，核对以 learning status 为准。
function learningState(learning, root, stateDir) {
  const task = learning.schedule?.taskName;
  return task ? `后台复盘已启用，计划任务 ${task} 已登记：对齐交付时在总结里写明这一点；用户问起先用 learning status 和系统任务核对，不重复注册。`
    : `后台复盘已启用但计划任务未登记：执行 \`${command(['learning', 'schedule', 'install', '--root', root], { stateDir })}\`；当前会话权限允许时可由代理直接执行，否则请用户在自己的终端执行。`;
}
function alignmentNote(role, alignment, session, task) {
  if (role !== 'lead' || !alignment || alignment.error) return '';
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
  if (alignment.stale) return `项目对齐索引已过期（${alignment.changed.length + alignment.missing.length + alignment.directoryChanged.length} 项变化）：只重读变化文件和新增资料，再用 apply/decide/suggest 的 sources 带上读取时快照确认已读来源；未确认来源仍会提示，不重新全量扫描。`;
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
    ...(task.channels ? { channels: task.channels } : {}),
    packages: packages.map(p => [p.packageId, p.role, p.status, p.deliveredRef || '-', p.role === 'reviewer' ? `${p.verdict || '-'}@${p.reviews || '-'}:${p.reviewedRef || '-'}` : '-', p.attempts || 0, p.channel || '-', p.supersededBy ? `>${p.supersededBy}` : '-'].join(' ')),
    validation: task.validation ? task.validation.ref : null,
    changes: task.changes?.length || 0,
  };
}
// 可选读取单独成段：hooks 在状态锁外调用，失败只降级为短提示，不回滚已保存的入口身份。
export async function readOptionalContext(state, resolved, sessionId, options = {}) {
  const project = resolved.project;
  const session = sessionId ? state.sessions[sessionKey(project.projectId, sessionId)] : null;
  const task = session?.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
  const optional = {};
  try { optional.alignment = await inspectAlignment(project); }
  catch (error) { optional.alignment = { error: { code: error.code || 'IO' } }; }
  if (options.directory && task?.lifecycle === 'active') {
    try { optional.knowledge = await selectKnowledge(options.directory, project.root, { text: task.goal, paths: task.permissions.allowedPaths }); }
    catch (error) { optional.knowledge = { error: { code: error.code || 'IO' } }; }
  }
  return optional;
}
// 自动入口只附命中、重要遗漏摘要与总数；排除清单和完整诊断留给显式查询。
function knowledgeSummary(knowledge) {
  return {
    selected: knowledge.selected,
    total: knowledge.total,
    excludedTotal: knowledge.excludedTotal,
    criticalOmitted: knowledge.criticalOmitted,
    criticalOmittedTotal: knowledge.criticalOmittedTotal,
    skippedTotal: knowledge.skippedTotal,
    ...(knowledge.missing ? { missing: true } : {}),
    version: knowledge.version,
    chars: knowledge.chars,
  };
}
export async function projectContext(state, resolved, role = 'lead', sessionId, options = {}) {
  if (!['lead', 'worker', 'reviewer'].includes(role)) fail('ROLE', '未知角色');
  const project = resolved.project;
  const session = sessionId ? state.sessions[sessionKey(project.projectId, sessionId)] : null;
  const pending = Object.values(state.pending).filter(p => p.projectId === project.projectId && p.kind === 'knowledge-pending' && p.status === 'open').slice(0, 1);
  const identity = session && !session.interrupted ? { schemaVersion: 1, projectId: project.projectId, sessionId, taskId: session.taskId, turnId: session.turnId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision: session.revision } : null;
  const instructions = {
    lead: '首次或范围变化时读公共方法和 Lead 指引。交付计划时一次给出建议分流、工作包划分（几包、每包范围与依赖）和所用通道；已有明确安排直接沿用，无 Worker 的任务不问 Worker，真实新增角色或通道时才按提问路径问用户。新业务用 signal task-start 声明 route（identity.taskId 为空时自拟 taskId，如 task-<简短英文>；续接沿用原 ID）；同一任务改目标或增/减权限范围用 signal task-update（仅该任务有效 Lead；只记录本机声明，宿主只读/计划权限仍优先），不必结束重开；简单任务 lead-direct 只需 task-start 和 task-end 两条信号。结构化提问工具会自动记 waiting-user，文本提问先发 phase waiting-user；派发/消费/审查结论用 packages 记录：单个包用 --package 加 --status、--ref 等便捷参数（reviewer 结果加 --verdict/--reviews），同批多个包或 change 用 --input（handle 填委派 ID，channel 填实际通道；用户指定通道时 task-start 带 channels，换通道先告诉用户并附 change；换新 packageId 返修用 supersedes）。明确纠正、失败原因或已验证方法出现时按 learningGuide 用 knowledge capture 保存；任务开始或范围变化用 knowledge select 检索经验。当前用户要求优先于历史经验。受委派的工作包会话（给出 packageId 与 worker/reviewer 角色）不按 Lead 行事：先 signal role-claim --role <角色> --package <packageId>，再读对应角色指引。',
    worker: '先读公共方法和 Worker 指引。只读工作包直接资料，必要的直接依赖可读；按阶段或范围变化说明【目标】和最小读取范围。不加载 Lead 调度，不递归创建代理，不发 task-start/packages。协作需要 workflow 身份而当前没有时，停止寻找并报告 Lead。复用有效证据；包内已授权的补测直接做，范围外补测先说明缺口交 Lead。发现随正常交付回报。',
    reviewer: '先读公共方法、Reviewer 指引和工作包指定范围。只读审查，不改源码、测试或配置，不递归创建代理，不发 task-start/packages。没有 workflow 身份时，停止寻找并报告 Lead。复用与待审版本匹配的证据；包内已授权的定向检查直接做，范围外补测先说明缺口交 Lead。完成即交回。',
  };
  // 同一会话、角色和版本已给过完整入口时，普通回合只给短指引；SessionStart（含压缩恢复）总是完整给出。
  const briefKey = `${role}@${PRODUCT_VERSION}`;
  const repeat = Boolean(options.incremental && !options.full && session?.briefed === briefKey);
  if (options.incremental && session) session.briefed = briefKey;
  const optional = options.optional || await readOptionalContext(state, resolved, sessionId, options);
  const alignment = optional.alignment;
  const notices = role === 'lead' ? (project.learning?.notices || []).filter(n => !n.acknowledged && !n.deliveredAt) : [];
  if (options.incremental) for (const notice of notices) notice.deliveredAt = new Date().toISOString();
  const task = session?.taskId ? state.tasks[taskKey(project.projectId, session.taskId)] : null;
  const note = alignmentNote(role, alignment, session, task);
  // 接入不自动授权后台维护（会真实调用模型）；Lead 在接入阶段补问一次，避免漏做。
  const learning = role !== 'lead' ? '' : project.learning?.enabled ? learningState(project.learning, project.root, options.directory)
    : !project.learning?.changedAt ? learningNote(project.root, options.directory) : '';
  const degraded = [];
  if (alignment?.error) degraded.push(`对齐状态未读取（${alignment.error.code}）：本回合不判断对齐变化，核心入口已保存。`);
  let knowledge;
  if (options.directory && task?.lifecycle === 'active') {
    knowledge = optional.knowledge || { error: { code: 'IO' } };
    if (knowledge.error) {
      degraded.push(`可选知识未检索（${knowledge.error.code}）：核心入口和任务状态已保存，修复后用 knowledge select 显式查询。`);
      if (options.incremental && session) session.contextKey = null;
      knowledge = { unavailable: knowledge.error };
    } else if (knowledge.unavailable) {
      degraded.push(knowledge.unavailable.kind === 'missing'
        ? `知识目录不存在（${knowledge.unavailable.code}）：可选知识为空，核心入口已保存。`
        : `可选知识读取失败（${knowledge.unavailable.code}）：已跳过，核心入口和任务状态不受影响，修复后用 knowledge select 显式查询。`);
      if (options.incremental && session) session.contextKey = null;
      knowledge = { unavailable: knowledge.unavailable };
    } else {
      // contextKey 只标记本次实际生成的内容；失败回合清空，下一次仍会重新检索。
      const key = JSON.stringify([task.taskId, task.goal, task.permissions.allowedPaths, knowledge.version]);
      if (options.incremental && session.contextKey === key) knowledge = { unchanged: true, version: knowledge.version };
      else {
        if (options.incremental && session) session.contextKey = key;
        if (knowledge.skippedTotal) degraded.push(`有 ${knowledge.skippedTotal} 条知识文件无法解析，已跳过；完整诊断用 knowledge select 查询。`);
        if (knowledge.excludedTotal) degraded.push(`可选知识另有 ${knowledge.excludedTotal} 条未附带（重要项 ${knowledge.criticalOmittedTotal} 条）；完整诊断用 knowledge select 查询。`);
        knowledge = knowledgeSummary(knowledge);
      }
    }
  }
  // 挂起任务（会话结束或中断后续接）也给账本，Lead 据此 task-start 续接而不重复派工。
  const ledger = role === 'lead' && ['active', 'suspended'].includes(task?.lifecycle) ? compactLedger(task) : null;
  // 有包在途时提醒：用户新消息若改变需求，走中途纠正流程，而不是只在 Lead 侧记下。
  const inflight = ledger && task.lifecycle === 'active' ? Object.values(task.packages || {}).filter(p => p.status === 'dispatched').map(p => p.packageId) : [];
  const correction = inflight.length ? `有 ${inflight.length} 个工作包在途（${inflight.join('、')}）：若本条用户消息改变需求或范围，按中途纠正流程先核对已有成果、取消并确认停止，再以新基准和用户原话重新派发。` : '';
  const planning = role === 'lead' && (session?.permissionMode === 'plan' || (task?.lifecycle === 'active' && task.permissions?.mode === 'plan'));
  const planHint = planning ? '当前为计划模式：交付计划时才须列出分几个工作包（每包范围与依赖）或说明免拆包理由，并一次列明各包所用通道；已有安排（任务声明的 channels 或包通道）直接沿用，Lead 直接执行的任务不问 Worker，只有真实新增的角色或通道才请用户确认。普通解释和讨论不触发这项核对。' : '';
  const leadRepeat = role === 'lead' ? '交付计划时一次列工作包和所用通道，已有安排直接沿用；' : '';
  const base = repeat ? `入口与本会话上一回合相同（文档、信号用法不变）：${leadRepeat}信号用 identity 字段加 signal <action> 子命令；需要时重读 ${role === 'lead' ? 'Lead' : role === 'worker' ? 'Worker' : 'Reviewer'} 指引。` : instructions[role];
  const instruction = [base, planHint, note, learning, correction, degraded.join(' ')].filter(Boolean).join(' ');
  const signal = repeat ? { command: signalUsage().command } : signalUsage();
  return {
    enabled: true, projectId: project.projectId, root: project.root, worktree: resolved.worktree,
    role, documents: [docPath('workflow.md'), docPath('roles', `${role}.md`)],
    cli: cliPath(), version: PRODUCT_VERSION, signal, identity,
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
