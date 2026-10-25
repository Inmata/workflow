import path from 'node:path';
import { canonical, digest, id, mutate, observeHost, readState, samePath, within } from './store.mjs';
import { acceptSignal, interrupt, openTurn, pendingFor, sessionKey, stop, taskKey, TERMINAL_PACKAGE } from './protocol.mjs';
import { resolveProject } from './projects.mjs';
import { projectContext, signalUsage } from './context.mjs';
import { PRODUCT_ROOT, PRODUCT_VERSION } from './entry.mjs';

export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'PreCompact', 'PostCompact'];
// Claude Code 没有 Interrupt 事件；StopFailure 承担中断保存语义，其余同名事件语义与 Codex 对齐。
export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'PreCompact', 'PostCompact'];
export const HOST_EVENTS = { codex: EVENTS, claude: CLAUDE_EVENTS };
export const HOSTS = ['codex', 'claude'];
// 提问工具名按宿主分表。Claude 依据本机 transcript 与 hooks 文档（MCP 名保留服务器连字符）；
// Codex 原生名来自本机 rollout，hook 中 MCP 名按源码为原始服务器名，下划线形式是模型可见名，保留兼容。
export const QUESTION_TOOLS = {
  codex: ['request_user_input', 'request_user_input_async', 'mcp__codeg-mcp__ask_user_question', 'mcp__codeg_mcp__ask_user_question'],
  claude: ['AskUserQuestion', 'mcp__codeg-mcp__ask_user_question'],
};
// 宿主内置子代理（Claude Agent 工具、Codex spawn_agent）的事件带 agent_id 并共享父 session_id；
// 这些事件不属于 Lead 回合，直接放行。`--agent` 启动的主会话只有 agent_type，不在此列。
export const isSubagentEvent = event => typeof event.agent_id === 'string' && event.agent_id.length > 0;
// Codeg 委派状态工具；两种写法对应 Claude（保留连字符）与 Codex（规范为下划线）。
export const DELEGATION_STATUS_TOOLS = ['mcp__codeg-mcp__get_delegation_status', 'mcp__codeg_mcp__get_delegation_status'];
const TERMINAL_DELEGATION = ['completed', 'failed', 'canceled'];
// 只取宿主返回的 {tasks:[{task_id,status}]} 结构，不扫描结果正文。
function delegationTasks(response, depth = 0) {
  if (depth > 5 || response === null || response === undefined) return [];
  if (typeof response === 'string') { const parsed = parseText(response); return parsed ? delegationTasks(parsed, depth + 1) : []; }
  if (Array.isArray(response)) return response.flatMap(item => delegationTasks(item, depth + 1));
  if (typeof response !== 'object') return [];
  if (Array.isArray(response.tasks)) return response.tasks.filter(t => typeof t?.task_id === 'string').map(t => ({ taskId: t.task_id, status: t.status }));
  if (typeof response.text === 'string') return delegationTasks(response.text, depth + 1);
  if (Array.isArray(response.content)) return delegationTasks(response.content, depth + 1);
  if (Object.hasOwn(response, 'output')) return delegationTasks(response.output, depth + 1);
  return [];
}
// 等待集合里仍有账本已记为终态的 handle 时提醒移出，避免重复带回已消费结果；只追加提示，不改宿主输出。
function delegationHint(state, project, event, turnId) {
  const session = state.sessions[sessionKey(project.projectId, event.session_id)];
  if (!session || session.role || (turnId && session.turnId !== turnId) || !session.taskId) return {};
  const task = state.tasks[taskKey(project.projectId, session.taskId)];
  if (task?.lifecycle !== 'active' || !task.packages) return {};
  const byHandle = new Map(Object.values(task.packages).filter(p => p.handle).map(p => [p.handle, p]));
  const settled = [], unrecorded = [];
  for (const item of delegationTasks(event.tool_response)) {
    const pkg = byHandle.get(item.taskId);
    if (pkg && TERMINAL_PACKAGE.includes(pkg.status)) settled.push(pkg.packageId);
    else if (pkg && TERMINAL_DELEGATION.includes(item.status) && pkg.status === 'dispatched') unrecorded.push(pkg.packageId);
  }
  const notes = [];
  if (settled.length) notes.push(`等待集合含账本已终态的包（${settled.join('、')}）：下次查询移出这些 task_id，不重读结果。`);
  if (unrecorded.length) notes.push(`包 ${unrecorded.join('、')} 的委派已结束：读取结果后在下一次 packages 中记为 delivered/consumed。`);
  return notes.length ? contextOutput('PostToolUse', `workflow 提示：${notes.join(' ')}`) : {};
}
const contextOutput = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
function parseText(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}
function extractSignals(response, depth = 0) {
  if (depth > 3 || response === null || response === undefined) return [];
  if (typeof response === 'string') {
    const full = parseText(response);
    if (full) return extractSignals(full, depth + 1);
    return response.split(/\r?\n/).flatMap(line => { const parsed = parseText(line); return parsed ? extractSignals(parsed, depth + 1) : []; });
  }
  if (typeof response !== 'object' || Array.isArray(response)) return [];
  if (Object.hasOwn(response, 'workflow_signal')) return [response.workflow_signal];
  // Claude Code 的 Bash tool_response 把命令输出放在 stdout；只认 stdout，不读 stderr。
  if (Object.hasOwn(response, 'stdout')) return extractSignals(response.stdout, depth + 1);
  if (Object.hasOwn(response, 'output')) return extractSignals(response.output, depth + 1);
  if (Array.isArray(response.content)) return response.content.filter(block => block.type === 'text').flatMap(block => extractSignals(block.text, depth + 1));
  return [];
}
function shellTokens(command) {
  // Deliberately accept one direct invocation only; shell composition requires a future verified adapter.
  if (typeof command !== 'string' || /[;|&`\r\n$<>]/.test(command)) return null;
  const tokens = [];
  const token = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/gy;
  let cursor = 0;
  while (cursor < command.length) {
    if (!command.slice(cursor).trim()) break;
    token.lastIndex = cursor;
    const match = token.exec(command);
    if (!match) return null;
    tokens.push(match[1] ?? match[2] ?? match[3]);
    cursor = token.lastIndex;
  }
  return tokens;
}
export function signalCommand(event) {
  const raw = event.tool_input?.command ?? event.tool_input?.cmd;
  if (typeof raw !== 'string') return null;
  // PowerShell 的直接调用可以带前导调用运算符 `&`；组合命令仍由 shellTokens 拒绝。
  return raw.trim().replace(/^&\s+/, '');
}
// 升级前开的会话可能仍持有旧发布副本的入口；状态根 releases 下的副本同属本插件，signal 输出格式一致，照常接受。
async function ownEntry(file, entry, directory) {
  const actual = await canonical(file);
  if (samePath(actual, await canonical(entry))) return true;
  if (!directory || path.basename(actual) !== 'workflow.mjs') return false;
  const releases = await canonical(path.join(directory, 'releases')).catch(() => null);
  return Boolean(releases && within(releases, actual) && path.relative(releases, actual).split(path.sep).length === 3);
}
export async function isSignalInvocation(event, entry = path.join(PRODUCT_ROOT, 'bin', 'workflow.mjs'), directory) {
  if (!['Bash', 'exec_command', 'PowerShell', 'powershell', 'pwsh'].includes(event.tool_name)) return false;
  const tokens = shellTokens(signalCommand(event));
  if (!tokens || tokens.length < 3) return false;
  const nodeToken = tokens[0];
  if (!['node', 'node.exe'].includes(nodeToken.toLowerCase()) && !samePath(path.resolve(nodeToken), process.execPath)) return false;
  try { if (!await ownEntry(tokens[1], entry, directory)) return false; } catch { return false; }
  let index = 2;
  while (tokens[index] === '--state-dir') index += 2;
  return tokens[index] === 'signal';
}
function isComposedSignal(event) {
  if (!['Bash', 'exec_command', 'PowerShell', 'powershell', 'pwsh'].includes(event.tool_name)) return false;
  const raw = signalCommand(event);
  // 入口可能藏在变量里（$wf=...; node $wf signal），命令里同时出现本插件入口和 signal --base64 就回执。
  return typeof raw === 'string' && /workflow\.mjs/.test(raw) && /\bsignal\s+--base64\b/.test(raw);
}
export async function handleHook(directory, event, options = {}) {
  try {
    const agent = HOSTS.includes(options.agent) ? options.agent : 'codex';
    if (!event || typeof event !== 'object' || !HOST_EVENTS[agent].includes(event.hook_event_name)) return {};
    if (agent === 'codex' && Object.hasOwn(event, 'transcript_path') && event.transcript_path === null) return {};
    if (typeof event.cwd !== 'string' || typeof event.session_id !== 'string' || !event.session_id) return {};
    const name = event.hook_event_name;
    if (process.env.WORKFLOW_REVIEW === '1') return {};
    if (isSubagentEvent(event)) return {};
    const question = QUESTION_TOOLS[agent].includes(event.tool_name);
    const signalInvocation = name === 'PostToolUse' && await isSignalInvocation(event, options.entry, directory);
    // 组合命令里的本插件 signal 不接受，但要回执说明，否则模型只能从 revision 反推信号丢失。
    const nearMiss = name === 'PostToolUse' && !signalInvocation && isComposedSignal(event);
    const delegationStatus = name === 'PostToolUse' && DELEGATION_STATUS_TOOLS.includes(event.tool_name);
    if (name === 'PostToolUse' && !question && !signalInvocation && !nearMiss && !delegationStatus) return {};
    // Codex 每个事件都带 turn_id；Claude Code 的入口事件带 prompt_id，用宿主值建立回合，缺失时才本机生成。
    const hostTurn = typeof event.turn_id === 'string' && event.turn_id ? event.turn_id : typeof event.prompt_id === 'string' && event.prompt_id ? event.prompt_id : null;
    const turnId = typeof event.turn_id === 'string' && event.turn_id ? event.turn_id : null;
    // Avoid creating even a lock or empty state for unregistered projects.
    const existing = await readState(directory);
    if (existing.install?.status === 'installed' && !options.synthetic) {
      const { verifyRelease } = await import('./install.mjs');
      if (!await verifyRelease(existing.install)) return { systemMessage: 'workflow 发布副本指纹变化，维护不可用；已保守放行。' };
    }
    const initial = await resolveProject(existing, event.cwd);
    if (!initial) return {};
    // 委派状态查询只读核对账本，不写状态：每次等待都落盘会放大锁竞争。
    if (name === 'PostToolUse' && delegationStatus) return delegationHint(existing, initial.project, event, turnId);
    return await mutate(directory, async (state, save) => {
      const resolved = await resolveProject(state, event.cwd);
      if (!resolved) return {};
      const project = resolved.project;
      let session = state.sessions[sessionKey(project.projectId, event.session_id)];
      // Observed callbacks prove execution of these hooks, not global discovery or trust policy.
      observeHost(state, agent, name, { at: new Date().toISOString(), sessionId: event.session_id, source: options.synthetic ? 'synthetic' : 'callback' });
      if (session && event.event_id && session.observed[event.event_id]) return {};
      if (name === 'SessionStart' || name === 'UserPromptSubmit') {
        // 会话开始后插件被重装：hook 已是新版本，但会话里已读的指引和命令仍是旧的，提示开新会话。
        const seenVersion = session?.productVersion;
        if (name === 'UserPromptSubmit') {
          // 每个用户回合开新票据；Claude 入口缺 prompt_id 时用本机值，后续事件按当前回合关联，不因标识缺失丢弃回执。
          session = openTurn(state, project, event.session_id, hostTurn || id('turn'), { compact: event.source === 'compact', eventId: event.event_id, mode: event.permission_mode });
        } else if (hostTurn) {
          session = openTurn(state, project, event.session_id, hostTurn, { compact: event.source === 'compact', eventId: event.event_id, mode: event.permission_mode });
        }
        if (session) session.productVersion = seenVersion || PRODUCT_VERSION;
        const upgraded = seenVersion && PRODUCT_VERSION && seenVersion !== PRODUCT_VERSION ? `workflow 插件已从 ${seenVersion} 升级到 ${PRODUCT_VERSION}：本会话早先读取的指引和命令可能已过时，请提醒用户开新会话；继续工作时以下面的入口为准。
` : '';
        // 已 role-claim 的委派会话注入对应角色的最小上下文，不再给 Lead 指引。
        return contextOutput(name, `${upgraded}workflow 入口：${JSON.stringify(await projectContext(state, resolved, session?.role || 'lead', event.session_id, { directory, incremental: true }))}`);
      }
      if (!session) return {};
      // Codex 严格核对 turn_id；Claude 的 prompt_id 只在入口事件保证存在，后续事件按当前回合关联。
      if (turnId && session.turnId !== turnId) return {};
      if (event.event_id) session.observed[event.event_id] = digest(JSON.stringify({ name, turn: event.turn_id }));
      if (name === 'PostToolUse') {
        if (question) {
          session.phase = 'waiting-user';
          session.revision += 1;
          session.revisionReason = '提问工具';
          return {};
        }
        if (nearMiss) {
          const usage = signalUsage();
          return contextOutput(name, `workflow 未接受：signal 须单独直接调用，本次命令含组合、变量或不是本插件入口。${usage.rule} 请用当前 identity 按此格式重发：${usage.command}`);
        }
        if (!signalInvocation) return {};
        const signals = extractSignals(event.tool_response);
        if (signals.length !== 1) return contextOutput(name, 'workflow 未接受：输出未包含唯一的本插件信号');
        const payload = signals[0];
        if (payload?.sessionId !== event.session_id || payload.projectId !== project.projectId || payload.turnId !== session.turnId) return contextOutput(name, 'workflow 未接受：信号不属于当前宿主会话/项目/回合');
        const before = structuredClone(state);
        let result;
        try { result = acceptSignal(state, payload); }
        catch (error) {
          // A rejected signal must not persist a partially changed phase or candidate disposition.
          for (const key of Object.keys(state)) delete state[key];
          Object.assign(state, before);
          // 附当前 revision 与回合，代理据此直接重发，不必再猜状态。
          const current = state.sessions[sessionKey(project.projectId, event.session_id)];
          result = { accepted: false, reason: error.code || 'INPUT', message: error.message, ...(error.missing ? { missing: error.missing } : {}), ...(error.findings ? { findings: error.findings } : {}), expectedRevision: current?.revision, turnId: current?.turnId };
        }
        return contextOutput(name, `workflow 回执：${JSON.stringify(result)}`);
      }
      if (name === 'Stop') {
        const output = stop(state, project, session, event);
        // The budget must be durable before returning a continuation decision.
        await save();
        return output;
      }
      if (name === 'Interrupt' || name === 'StopFailure') { interrupt(state, project, session); return {}; }
      if (name === 'SessionEnd') {
        interrupt(state, project, session);
        return {};
      }
      // PostCompact cannot emit additional context; compact SessionStart restores the existing identity.
      if (name === 'PostCompact') return {};
      return {};
    });
  } catch (error) {
    // Never return a continuation when identity, persistence, schema or locking failed.
    return { systemMessage: `workflow 已保守放行，维护暂不可用：${error.code || 'IO'}；保留状态和待办。` };
  }
}
