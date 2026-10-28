import { fail, SCHEMA_VERSION } from './store.mjs';
import { identifier, sessionKey } from './protocol.mjs';

export const SIGNAL_ACTIONS = ['task-start', 'task-update', 'phase', 'packages', 'role-claim', 'task-end', 'disposition'];
const IDENTITY_FIELDS = ['schemaVersion', 'projectId', 'sessionId', 'turnId', 'ticket', 'interruptEpoch', 'expectedRevision', 'signalId', 'action'];
const FIELD_OPTIONS = ['task', 'goal', 'route', 'mode', 'paths', 'paths-mode', 'plans', 'channels', 'parent', 'phase', 'delivery', 'role', 'package', 'final-ref'];
// task-update 只接受这些便捷字段；其余字段属于其他动作，给出即报错，不能静默丢弃。
const TASK_UPDATE_OPTIONS = ['task', 'goal', 'mode', 'paths', 'paths-mode'];
const list = value => value === undefined ? undefined : value.split(',').map(item => item.trim()).filter(Boolean);
// 命令行与 --input 可各给一半权限：按 mode/allowedPaths 子字段合并；同一子字段两处冲突时拒绝，避免整体覆盖后静默丢字段。
function mergePermissions(cli, input) {
  if (input === undefined) return cli;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (Object.keys(cli).length) fail('INPUT', '--input 的 permissions 需为 {mode?, allowedPaths?} 对象，才能与命令行字段合并');
    return input;
  }
  const merged = { ...input };
  for (const key of ['mode', 'allowedPaths']) {
    if (cli[key] === undefined) continue;
    if (merged[key] !== undefined && JSON.stringify(merged[key]) !== JSON.stringify(cli[key])) {
      fail('INPUT', `--${key === 'mode' ? 'mode' : 'paths'} 与 --input 的 permissions.${key} 不一致；同一个值只在一处给出`);
    }
    merged[key] = cli[key];
  }
  return merged;
}
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
    const cli = {};
    if (options.mode !== undefined) cli.mode = options.mode;
    if (options.paths !== undefined) cli.allowedPaths = list(options.paths) || [];
    const permissions = Object.keys(cli).length || extra.permissions !== undefined ? mergePermissions(cli, extra.permissions) : undefined;
    // 新任务要求 permissions 完整：只给 --mode 时仍按空数组补全 allowedPaths。
    if (permissions && typeof permissions === 'object' && !Array.isArray(permissions) && permissions.allowedPaths === undefined && options.mode !== undefined) permissions.allowedPaths = [];
    if (permissions !== undefined) delete extra.permissions;
    Object.assign(fields, {
      goal: options.goal, route: options.route, parentTaskId: options.parent, plans: list(options.plans), channels: channels(options.channels),
      ...(permissions !== undefined ? { permissions } : {}),
    });
  } else if (action === 'task-update') {
    const unsupported = FIELD_OPTIONS.filter(key => !TASK_UPDATE_OPTIONS.includes(key) && options[key] !== undefined);
    if (unsupported.length) fail('UNSUPPORTED', `task-update 不支持 ${unsupported.map(key => `--${key}`).join('、')}；只能用 --goal、--mode、--paths 与 --paths-mode`);
    // 只带调用方明确给出的字段；省略的 mode/allowedPaths 保持原值。allowedPathsMode 缺省按 replace。
    const cli = {};
    if (options.mode !== undefined) cli.mode = options.mode;
    if (options.paths !== undefined) cli.allowedPaths = list(options.paths) || [];
    const permissions = Object.keys(cli).length || extra.permissions !== undefined ? mergePermissions(cli, extra.permissions) : undefined;
    if (permissions !== undefined) delete extra.permissions;
    Object.assign(fields, {
      goal: options.goal,
      ...(permissions !== undefined ? { permissions } : {}),
      ...(options['paths-mode'] !== undefined ? { allowedPathsMode: options['paths-mode'] } : {}),
    });
  } else if (action === 'phase') Object.assign(fields, { phase: options.phase, deliveryId: options.delivery });
  else if (action === 'role-claim') Object.assign(fields, { role: options.role, packageId: options.package });
  else if (action === 'task-end') Object.assign(fields, { finalRef: options['final-ref'] });
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
  const payload = { schemaVersion: SCHEMA_VERSION, projectId, sessionId, turnId, taskId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision, signalId, action, ...extra, ...fields };
  if (action === 'packages' && !Array.isArray(payload.packages)) fail('INPUT', 'packages 信号需要 --input 提供 {packages:[...]}');
  return payload;
}
