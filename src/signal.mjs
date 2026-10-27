import { fail, SCHEMA_VERSION } from './store.mjs';
import { identifier, sessionKey } from './protocol.mjs';

export const SIGNAL_ACTIONS = ['task-start', 'phase', 'packages', 'role-claim', 'task-end', 'disposition'];
const IDENTITY_FIELDS = ['schemaVersion', 'projectId', 'sessionId', 'turnId', 'ticket', 'interruptEpoch', 'expectedRevision', 'signalId', 'action'];
const FIELD_OPTIONS = ['task', 'goal', 'route', 'mode', 'paths', 'plans', 'channels', 'parent', 'phase', 'delivery', 'role', 'package', 'final-ref'];
const list = value => value === undefined ? undefined : value.split(',').map(item => item.trim()).filter(Boolean);
// worker=codeg:claude_code,reviewer=codeg:codex
function channels(value) {
  if (value === undefined) return undefined;
  return Object.fromEntries(list(value).map(pair => {
    const at = pair.indexOf('=');
    if (at < 1) fail('ARGUMENT', '--channels 格式为 worker=<通道>,reviewer=<通道>');
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
}
// 便捷入口：身份字段只从本机状态取，不猜“最近会话”；会话、回合必须由调用方给出且与状态一致。
// 只拼出与 --input 写法相同的规范 payload，仍由 PostToolUse 的 acceptSignal 校验和写入，两条入口共用一个状态机。
export function buildSignal(state, resolved, action, options, extra = {}) {
  if (!SIGNAL_ACTIONS.includes(action)) fail('ACTION', `未知信号动作 ${action}；支持 ${SIGNAL_ACTIONS.join('/')}`);
  const sessionId = identifier(options.session, '--session');
  const turnId = identifier(options.turn, '--turn');
  const signalId = identifier(options.id, '--id');
  const projectId = resolved.project.projectId;
  const session = state.sessions[sessionKey(projectId, sessionId)];
  if (!session) fail('IDENTITY', '当前项目没有这个会话；--session 取 context identity.sessionId');
  if (session.turnId !== turnId || session.interrupted) fail('STALE', `回合已失效（当前 turnId=${session.interrupted ? '已中断' : session.turnId}）；按当前 identity 重发`);
  // role-claim 的 taskId 只作标识（委派子会话此时还没有自己的任务）；没给 --task 时按工作包派生。
  const fallbackTask = session.taskId || (action === 'role-claim' ? `claim-${options.package || options.role || 'role'}` : undefined);
  const taskId = identifier(options.task || fallbackTask, '--task');
  // hook 只认单条直接调用，命令里出现这些字符（引号内也算）整条信号不被接受；在这里先拒，免得白跑一轮。
  const unsafe = FIELD_OPTIONS.filter(key => typeof options[key] === 'string' && /[;|&`$<>\r\n]/.test(options[key])).map(key => `--${key}`);
  if (unsafe.length) fail('INPUT', `${unsafe.join('、')} 含 ; | & $ < > 或反引号、换行，hook 不会接受这条命令；改写文字，或把字段写进 JSON 文件用 --input 传`);
  const misplaced = Object.keys(extra).filter(key => IDENTITY_FIELDS.includes(key) || key === 'taskId');
  if (misplaced.length) fail('INPUT', `--input 不要带身份字段（${misplaced.join('、')}），由命令行参数和本机状态补齐`);
  // 同一 signalId 重放时复原首次的 expectedRevision（接受后 revision 恰好 +1），正文一致才能命中回执而不是 SIGNAL_ID。
  const receipt = session.receipts?.[signalId];
  const expectedRevision = Number.isSafeInteger(receipt?.result?.revision) ? receipt.result.revision - 1 : session.revision;
  const fields = {};
  if (action === 'task-start') {
    Object.assign(fields, {
      goal: options.goal, route: options.route, parentTaskId: options.parent, plans: list(options.plans), channels: channels(options.channels),
      ...(options.mode !== undefined || options.paths !== undefined ? { permissions: { mode: options.mode, allowedPaths: list(options.paths) || [] } } : {}),
    });
  } else if (action === 'phase') Object.assign(fields, { phase: options.phase, deliveryId: options.delivery });
  else if (action === 'role-claim') Object.assign(fields, { role: options.role, packageId: options.package });
  else if (action === 'task-end') Object.assign(fields, { finalRef: options['final-ref'] });
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
  const payload = { schemaVersion: SCHEMA_VERSION, projectId, sessionId, turnId, taskId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision, signalId, action, ...extra, ...fields };
  if (action === 'packages' && !Array.isArray(payload.packages)) fail('INPUT', 'packages 信号需要 --input 提供 {packages:[...]}');
  return payload;
}
