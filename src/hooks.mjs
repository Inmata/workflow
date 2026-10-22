import path from 'node:path';
import { canonical, digest, id, mutate, observeHost, readState, samePath } from './store.mjs';
import { acceptSignal, interrupt, openTurn, pendingFor, sessionKey, stop, taskKey } from './protocol.mjs';
import { resolveProject } from './projects.mjs';
import { PRODUCT_ROOT, projectContext } from './context.mjs';

export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'PreCompact', 'PostCompact'];
// Claude Code 没有 Interrupt 事件；StopFailure 承担中断保存语义，其余同名事件语义与 Codex 对齐。
export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'PreCompact', 'PostCompact'];
export const HOST_EVENTS = { codex: EVENTS, claude: CLAUDE_EVENTS };
export const HOSTS = ['codex', 'claude'];
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
export async function isSignalInvocation(event, entry = path.join(PRODUCT_ROOT, 'bin', 'workflow.mjs')) {
  if (!['Bash', 'exec_command', 'PowerShell', 'powershell', 'pwsh'].includes(event.tool_name)) return false;
  const tokens = shellTokens(signalCommand(event));
  if (!tokens || tokens.length < 3) return false;
  const nodeToken = tokens[0];
  if (!['node', 'node.exe'].includes(nodeToken.toLowerCase()) && !samePath(path.resolve(nodeToken), process.execPath)) return false;
  try { if (!samePath(await canonical(tokens[1]), await canonical(entry))) return false; } catch { return false; }
  let index = 2;
  while (tokens[index] === '--state-dir') index += 2;
  return tokens[index] === 'signal';
}
export async function handleHook(directory, event, options = {}) {
  try {
    const agent = HOSTS.includes(options.agent) ? options.agent : 'codex';
    if (!event || typeof event !== 'object' || !HOST_EVENTS[agent].includes(event.hook_event_name)) return {};
    if (agent === 'codex' && Object.hasOwn(event, 'transcript_path') && event.transcript_path === null) return {};
    if (typeof event.cwd !== 'string' || typeof event.session_id !== 'string' || !event.session_id) return {};
    const name = event.hook_event_name;
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
    const signalInvocation = name === 'PostToolUse' && await isSignalInvocation(event, options.entry);
    return await mutate(directory, async (state, save) => {
      const resolved = await resolveProject(state, event.cwd);
      if (!resolved) return {};
      const project = resolved.project;
      let session = state.sessions[sessionKey(project.projectId, event.session_id)];
      // Observed callbacks prove execution of these hooks, not global discovery or trust policy.
      observeHost(state, agent, name, { at: new Date().toISOString(), sessionId: event.session_id, source: options.synthetic ? 'synthetic' : 'callback' });
      if (session && event.event_id && session.observed[event.event_id]) return {};
      if (name === 'SessionStart' || name === 'UserPromptSubmit') {
        if (name === 'UserPromptSubmit') {
          // 每个用户回合开新票据；Claude 入口缺 prompt_id 时用本机值，后续事件按当前回合关联，不因标识缺失丢弃回执。
          session = openTurn(state, project, event.session_id, hostTurn || id('turn'), { compact: event.source === 'compact', eventId: event.event_id, mode: event.permission_mode });
        } else if (hostTurn) {
          session = openTurn(state, project, event.session_id, hostTurn, { compact: event.source === 'compact', eventId: event.event_id, mode: event.permission_mode });
        }
        return contextOutput(name, `workflow 入口：${JSON.stringify(await projectContext(state, resolved, 'lead', event.session_id))}`);
      }
      if (!session) return {};
      // Codex 严格核对 turn_id；Claude 的 prompt_id 只在入口事件保证存在，后续事件按当前回合关联。
      if (turnId && session.turnId !== turnId) return {};
      if (event.event_id) session.observed[event.event_id] = digest(JSON.stringify({ name, turn: event.turn_id }));
      if (name === 'PostToolUse') {
        if (['request_user_input', 'mcp__codeg_mcp__ask_user_question'].includes(event.tool_name)) {
          session.phase = 'waiting-user';
          session.revision += 1;
          return {};
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
          result = { accepted: false, reason: error.code || 'INPUT', message: error.message };
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
        if (session.taskId) {
          const task = state.tasks[taskKey(project.projectId, session.taskId)];
          if (task?.lifecycle === 'active') pendingFor(state, project.projectId, task.taskId, '会话结束；不自动继续业务', 'business-incomplete');
        }
        session.ticket = null;
        session.interrupted = true;
        session.phase = 'unknown';
        session.revision += 1;
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
