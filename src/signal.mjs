import { fail, SCHEMA_VERSION } from './store.mjs';
import { identifier, sessionKey, taskKey } from './protocol.mjs';

export const SIGNAL_ACTIONS = ['task-start', 'task-update', 'phase', 'packages', 'role-claim', 'task-end', 'disposition'];
const IDENTITY_FIELDS = ['schemaVersion', 'projectId', 'sessionId', 'turnId', 'ticket', 'interruptEpoch', 'expectedRevision', 'signalId', 'action'];
// 单个工作包的便捷字段；同批多个包、change 等深层结构仍用 --input。
const PACKAGE_OPTIONS = ['status', 'channel', 'handle', 'ref', 'depends-on', 'supersedes', 'verdict', 'reviews', 'base-ref', 'note', 'worktree'];
// --package 与 --role 只属于 packages/role-claim；给错动作同样报错，不能静默丢弃。
const PACKAGE_SINGLE_OPTIONS = ['package', 'role', ...PACKAGE_OPTIONS];
const VALIDATION_OPTIONS = ['validation-ref', 'evidence'];
// task-update 只接受这些便捷字段；其余字段属于其他动作，给出即报错，不能静默丢弃。
const TASK_UPDATE_OPTIONS = ['task', 'goal', 'mode', 'paths', 'paths-mode'];
// 命令行全局解析器还接受 --path、--ref 等与信号无关的选项；task-update 只放行实际会用到的公共选项。
// 清单与 bin/workflow.mjs 的解析器保持一致：身份、项目定位、输入与状态目录。
const TASK_UPDATE_COMMON_OPTIONS = ['session', 'turn', 'id', 'project', 'root', 'state-dir', 'input', 'base64'];
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
// 重复 --evidence 在解析器里收集为数组，其余字段仍是单个字符串；不安全字符检查对两者一致。
const values = value => Array.isArray(value) ? value : value === undefined ? [] : [value];
// 命令行与 --input 可各给一半：同一字段两处值不同拒绝，相同值可合并。
function mergeField(merged, cli, key, flag, label = key) {
  if (cli[key] === undefined) return;
  if (merged[key] !== undefined && JSON.stringify(merged[key]) !== JSON.stringify(cli[key])) {
    fail('INPUT', `--${flag} 与 --input 的 ${label} 不一致；同一个值只在一处给出`);
  }
  merged[key] = cli[key];
}
// 单个工作包的便捷写法。--ref 按包角色落到 deliveredRef（worker）或 reviewedRef（reviewer）；
// 角色取 --role 或已有包记录，两者都没有时要求显式给出，避免把交付引用写到错误字段。
function packageFromCli(state, projectId, taskId, options) {
  const item = {};
  if (options.role !== undefined) item.role = options.role;
  for (const [flag, key] of Object.entries({ status: 'status', channel: 'channel', handle: 'handle', note: 'note', worktree: 'worktree', 'base-ref': 'baseRef', supersedes: 'supersedes', verdict: 'verdict', reviews: 'reviews' })) {
    if (options[flag] !== undefined) item[key] = options[flag];
  }
  if (options['depends-on'] !== undefined) item.dependsOn = list(options['depends-on']) || [];
  if (options.ref !== undefined) {
    const role = options.role || state.tasks?.[taskKey(projectId, taskId)]?.packages?.[options.package]?.role;
    if (!['worker', 'reviewer'].includes(role)) fail('INPUT', 'packages 的 --ref 需要知道包角色：新建包时同时给 --role，或只对已有包使用；worker 记 deliveredRef，reviewer 记 reviewedRef');
    item[role === 'reviewer' ? 'reviewedRef' : 'deliveredRef'] = options.ref;
  }
  return item;
}
function validationFromCli(options) {
  const value = {};
  if (options['validation-ref'] !== undefined) value.ref = options['validation-ref'];
  if (options.evidence !== undefined) value.evidence = values(options.evidence);
  return value;
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
  // 字段值是单个 CLI 参数，Hook 是否接受由它解析真实命令行时的引号状态决定；
  // 这里不能只看字面字符就拒绝，否则 PowerShell 单引号内合法传值的自由文本会被误伤。
  // 新便捷字段只在对应动作生效；给错动作直接报错，避免看起来成功却没有写入。
  // task-update 自己会按公共选项清单报 UNSUPPORTED，这里不抢先改变它的错误码。
  if (action !== 'packages' && action !== 'task-update') {
    // role-claim 也要 --role 与 --package；其余动作收到任一个包字段都拒绝。
    const stray = PACKAGE_SINGLE_OPTIONS.filter(key => options[key] !== undefined && !(action === 'role-claim' && ['role', 'package'].includes(key)));
    if (stray.length) fail('INPUT', `${stray.map(key => `--${key}`).join('、')} 只用于 packages 信号${action === 'task-end' ? '；验证证据用 --validation-ref 与 --evidence' : ''}`);
  }
  if (action !== 'task-end') {
    const stray = VALIDATION_OPTIONS.filter(key => options[key] !== undefined);
    if (stray.length) fail('INPUT', `${stray.map(key => `--${key}`).join('、')} 只用于 task-end 信号；packages 的 validation 随同批载荷放进 --input`);
  }
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
    // 按实际传入的参数检查：全局解析器接受的 --path/--ref 等不属于 task-update，静默丢弃会让调用方误以为生效。
    const unsupported = Object.keys(options).filter(key => !TASK_UPDATE_OPTIONS.includes(key) && !TASK_UPDATE_COMMON_OPTIONS.includes(key));
    if (unsupported.length) fail('UNSUPPORTED', `task-update 不支持 ${unsupported.map(key => `--${key}`).join('、')}；只能用 --task、--goal、--mode、--paths、--paths-mode，公共选项限 --session、--turn、--id、--project、--root、--state-dir、--input、--base64`);
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
  else if (action === 'packages') {
    if (options.package !== undefined) {
      // 便捷参数只表达一个包；同批多个包或 change 仍用 --input，两处都给 packages 时报冲突而不是覆盖。
      if (extra.packages !== undefined) fail('INPUT', '--package 与 --input 的 packages 不能同时给出；同批多个包、change 等继续用 --input');
      const item = packageFromCli(state, projectId, taskId, options);
      if (!Object.keys(item).length) fail('INPUT', '--package 需要至少一个包字段（如 --status、--role、--ref、--verdict）');
      fields.packages = [{ packageId: identifier(options.package, '--package'), ...item }];
    } else {
      // --input 带 packages 时，单包便捷字段没有包 ID 可落，不能当作已生效；直接拒绝并指向批量写法。
      const stray = PACKAGE_SINGLE_OPTIONS.filter(key => options[key] !== undefined);
      if (stray.length) fail('INPUT', `${stray.map(key => `--${key}`).join('、')}：单包便捷字段需配 --package；同批多包请全部写进 --input`);
    }
  } else if (action === 'task-end') {
    Object.assign(fields, { finalRef: options['final-ref'] });
    // 最常用形态：--final-ref <提交> --evidence "…" --evidence "…"；--final-ref 缺省充当 validation.ref。
    // waivers、多项复杂 validation 仍放在 --input，两处同一子字段冲突时报 INPUT。
    const cliValidation = validationFromCli(options);
    if (Object.keys(cliValidation).length) {
      if (options['validation-ref'] !== undefined && options['final-ref'] !== undefined && options['validation-ref'] !== options['final-ref']) {
        fail('INPUT', '--validation-ref 与 --final-ref 不一致：validation.ref 必须等于最终交付版本');
      }
      if (cliValidation.ref === undefined && options['final-ref'] !== undefined) cliValidation.ref = options['final-ref'];
      if (cliValidation.evidence !== undefined && cliValidation.ref === undefined && extra.validation?.ref === undefined) {
        fail('INPUT', '--evidence 需要 --validation-ref 或 --final-ref；完整 validation 也可放进 --input');
      }
      if (extra.validation === undefined) fields.validation = cliValidation;
      else {
        if (!extra.validation || typeof extra.validation !== 'object' || Array.isArray(extra.validation)) fail('INPUT', '--input 的 validation 需为 {ref, evidence[]} 对象，才能与命令行字段合并');
        const merged = { ...extra.validation };
        mergeField(merged, cliValidation, 'ref', 'validation-ref', 'validation.ref');
        mergeField(merged, cliValidation, 'evidence', 'evidence', 'validation.evidence');
        delete extra.validation;
        fields.validation = merged;
      }
    }
  }
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
  const payload = { schemaVersion: SCHEMA_VERSION, projectId, sessionId, turnId, taskId, ticket: session.ticket, interruptEpoch: session.interruptEpoch, expectedRevision, signalId, action, ...extra, ...fields };
  if (action === 'packages' && !Array.isArray(payload.packages)) fail('INPUT', 'packages 信号需要 --input 提供 {packages:[...]}');
  return payload;
}
