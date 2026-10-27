#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fail, readState, stateDirectory } from '../src/store.mjs';
import { resolveProject } from '../src/projects.mjs';
import { getContext } from '../src/context.mjs';
import { handleHook, HOSTS as AGENTS } from '../src/hooks.mjs';
import { gateReport, taskKey, unchangedPlans } from '../src/protocol.mjs';
import { cliPath } from '../src/entry.mjs';

const allowed = new Set(['state-dir', 'user-dir', 'root', 'project', 'role', 'session', 'input', 'base64', 'agent', 'owner', 'coexistence-mode', 'transaction', 'pending', 'max-files', 'skip-learning', 'enable-learning', 'help']);
function argumentsFor(argv) {
  const options = {}, commands = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) { commands.push(value); continue; }
    const key = value.slice(2);
    if (!allowed.has(key) || Object.hasOwn(options, key)) fail('ARGUMENT', `未知或重复参数 --${key}`);
    if (['help', 'global', 'now', 'skip-learning', 'enable-learning'].includes(key)) { options[key] = true; continue; }
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail('ARGUMENT', `参数 --${key} 缺少值`);
    options[key] = argv[++index];
  }
  return { options, commands };
}
async function stdin() { let value = ''; for await (const part of process.stdin) value += part.toString('utf8'); return value; }
async function inputJSON(options) {
  if (options.input && options.base64) fail('ARGUMENT', '--input 和 --base64 只能选一个');
  const text = options.input ? await readFile(path.resolve(options.input), 'utf8') : options.base64 ? Buffer.from(options.base64, 'base64').toString('utf8') : await stdin();
  try { const input = JSON.parse(text.replace(/^\uFEFF/, '')); if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INPUT', 'JSON 必须是对象'); return input; }
  catch (error) { if (error.code) throw error; fail('JSON', '输入不是有效 JSON；未执行写入'); }
}
const help = {
  usage: 'node bin/workflow.mjs <命令> [--state-dir <本机状态目录>]',
  commands: [
    'install --agent codex|claude [--user-dir <宿主配置目录>]', 'uninstall --agent codex|claude', 'doctor [--agent codex|claude] [--project <目录>]',
    'project onboard --root <目录> [--enable-learning|--skip-learning]（推荐：先全部预检，通过才接入并扫描；--enable-learning 同时启用后台复盘并注册计划任务，须用户在终端执行）',
    'project remove --root <目录>（清除本机绑定、计划任务、管理区和本机数据；项目内资料只列出不删）',
    'project enable --root <目录> [--coexistence-mode bounded|pending-only]',
    'project disable --root <目录>', 'project attach-worktree --project <projectId> --root <目录>',
    'project align scan|status --root <目录> [--max-files N]',
    'project align apply|decide|suggest --root <目录> --input <JSON文件>',
    'context --role lead|worker|reviewer [--project <目录>] [--session <sessionId>]',
    'task show --task <taskId> [--project <目录>]（只读查看分流、工作包账本、变更条数与门禁缺项）',
    'spec check [--project <目录>] [--ref <提交>]（只读检查 .spec 管辖文件是否漂移；有发现时退出码 1）',
    'signal <task-start|phase|role-claim|task-end|packages> --session <id> --turn <id> --id <signalId> [--task <id>] [--goal --route --mode --paths a,b --plans a,b --channels worker=x,reviewer=y --parent | --phase --delivery | --role --package | --final-ref] [--input <补充字段 JSON>]（推荐：身份由本机状态补齐）',
    'signal --input <JSON文件> | --base64 <UTF-8 JSON>（完整 payload，兼容写法）',
    'knowledge inspect --path <资料路径> [--project <目录>]',
    'knowledge apply --input <JSON文件>', 'knowledge recover --transaction <id> [--project <目录>]',
    'knowledge capture|feedback|revise --input <JSON文件> [--root <项目>]',
    'knowledge select|explain --query <任务描述> [--path <当前路径>] [--root <项目>]',
    'learning config get|set [--global] [--input <JSON文件>] [--root <项目>]',
    'learning enable|disable|status|migrate|acknowledge [--root <项目>]', 'learning doctor [--global] [--root <项目>]（不调用模型）',
    'learning review [--now] [--root <项目>]（真实模型调用）',
    'learning recover --run <运行ID> [--root <项目>]（不调用模型）',
    'learning schedule preview|install|remove [--root <项目>]',
    'pending list [--project <目录>]', 'pending inspect --pending <id> [--project <目录>]', 'pending create --input <JSON文件>',
    'hook --agent codex|claude（stdin 为宿主事件）',
  ],
  note: 'signal 只输出，需当前宿主 PostToolUse 接受；未知状态、提问和中断不发补偿。不会自动提交或发布。',
};
// --path is a document-only option; it is never used to construct shell commands.
allowed.add('path');
for (const key of ['global', 'now', 'query', 'run', 'version', 'task', 'ref']) allowed.add(key);
// signal 便捷子命令的字段参数；身份字段（ticket、epoch、revision）不接受命令行传入，只从状态补齐。
for (const key of ['turn', 'id', 'goal', 'route', 'mode', 'paths', 'plans', 'channels', 'parent', 'phase', 'delivery', 'package', 'final-ref']) allowed.add(key);
async function structuredSignal(directory, root, action, options) {
  const { buildSignal } = await import('../src/signal.mjs');
  const state = await readState(directory);
  const resolved = await resolveProject(state, root);
  if (!resolved) fail('PROJECT', '当前目录没有有效项目绑定');
  // 便捷写法不读 stdin：没有 --input/--base64 就只用命令行字段。
  const extra = options.input || options.base64 ? await inputJSON(options) : {};
  return { workflow_signal: buildSignal(state, resolved, action, options, extra) };
}
// 只读：返回任务账本与当前门禁缺项，不改变状态。
async function showTask(state, root, taskId) {
  const resolved = await resolveProject(state, root);
  if (!resolved) fail('PROJECT', '当前目录没有有效项目绑定');
  const task = state.tasks[taskKey(resolved.project.projectId, taskId)];
  if (!task) fail('TASK', '任务不存在或不属于当前项目');
  const { taskId: id, goal, parentTaskId, route = null, channels = null, lifecycle, packages = {}, validation = null, waivers = [], finalRef = null, changes = [] } = task;
  const gate = lifecycle === 'active' ? gateReport(state, task, finalRef) : { missing: [], findings: [] };
  const plans = (task.plans || []).map(plan => plan.path);
  const planUnchanged = lifecycle === 'active' ? unchangedPlans(state, task) : [];
  return { taskId: id, goal, parentTaskId, route, channels, lifecycle, packages: Object.values(packages), validation, waivers, finalRef, changes: changes.length, gateMissing: gate.missing, specFindings: gate.findings, plans, planUnchanged, note: '门禁核对声明记录一致性，不证明审查或测试真实发生' };
}
async function main() {
  const { options, commands } = argumentsFor(process.argv.slice(2));
  const [command, action, subaction] = commands;
  if (options.help || !command) return help;
  const positional = (command === 'project' && action === 'align') || (command === 'learning' && ['config', 'schedule'].includes(action)) ? 3 : ['project', 'knowledge', 'pending', 'learning', 'task', 'spec', 'signal'].includes(command) ? 2 : 1;
  if (commands.length > positional) fail('ARGUMENT', '命令后存在多余的位置参数');
  const agent = options.agent || 'codex';
  if (!AGENTS.includes(agent)) fail('AGENT', `未知宿主 ${agent}；支持 ${AGENTS.join('/')}`);
  const directory = stateDirectory(options['state-dir']);
  const root = options.root || options.project || process.cwd();
  if (command === 'signal') return action ? structuredSignal(directory, root, action, options) : { workflow_signal: await inputJSON(options) };
  if (command === 'hook') {
    try { return await handleHook(directory, await inputJSON(options), { agent }); }
    catch { return { systemMessage: 'workflow 事件输入无效，已保守放行。' }; }
  }
  if (command === 'install') return (await import('../src/install.mjs')).install(directory, { userDir: options['user-dir'], agent });
  if (command === 'uninstall') return (await import('../src/install.mjs')).uninstall(directory, { agent });
  if (command === 'doctor') return (await import('../src/install.mjs')).doctor(directory, options.project, { agent, userDir: options['user-dir'] });
  if (command === 'context') return getContext(directory, root, options.role || 'lead', options.session);
  if (command === 'task' && action === 'show') {
    if (!options.task) fail('ARGUMENT', 'task show 需要 --task');
    return showTask(await readState(directory), root, options.task);
  }
  // 只读：不需要项目绑定，CI 里也能直接运行。
  if (command === 'spec' && action === 'check') {
    if (options.ref !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.\/~^@{}-]{0,199}$/.test(options.ref)) fail('ARGUMENT', '--ref 不是有效的提交引用');
    const { checkSpecs } = await import('../src/spec.mjs');
    const result = checkSpecs(path.resolve(root), { ref: options.ref });
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === 'project') {
    if (action === 'onboard') { if (!options.root) fail('ARGUMENT', 'onboard 需要明确 --root'); if (options['enable-learning'] && options['skip-learning']) fail('ARGUMENT', '--enable-learning 与 --skip-learning 不能同时使用'); return (await import('../src/onboard.mjs')).onboardProject(directory, options.root, { coexistenceMode: options['coexistence-mode'], skipLearning: options['skip-learning'], enableLearning: options['enable-learning'] }); }
    if (action === 'remove') { if (!options.root) fail('ARGUMENT', 'remove 需要明确 --root'); return (await import('../src/onboard.mjs')).removeProject(directory, options.root); }
    const { enableProject, disableProject, attachWorktree, setOwner } = await import('../src/projects.mjs');
    if (action === 'enable') { if (!options.root) fail('ARGUMENT', 'enable 需要明确 --root'); return enableProject(directory, options.root, { coexistenceMode: options['coexistence-mode'] }); }
    if (action === 'disable') { if (!options.root) fail('ARGUMENT', 'disable 需要明确 --root'); return disableProject(directory, options.root); }
    if (action === 'attach-worktree') { if (!options.project || !options.root) fail('ARGUMENT', '需要明确 --project ID 和 --root'); return attachWorktree(directory, options.project, options.root); }
    if (action === 'owner') return setOwner(directory, options.project);
    if (action === 'align') {
      const { alignmentStatus, applyAlignment, decideAlignment, scanAlignment, suggestAlignment } = await import('../src/alignment.mjs');
      if (subaction === 'scan') return scanAlignment(directory, root, { maxFiles: options['max-files'] });
      if (subaction === 'status') return alignmentStatus(directory, root);
      if (subaction === 'apply') return applyAlignment(directory, root, await inputJSON(options));
      if (subaction === 'decide') return decideAlignment(directory, root, await inputJSON(options));
      if (subaction === 'suggest') return suggestAlignment(directory, root, await inputJSON(options));
    }
  }
  if (command === 'knowledge') {
    const { capture, feedback, reviseKnowledge, selectKnowledge } = await import('../src/learning.mjs');
    if (action === 'capture') return capture(directory, await inputJSON(options));
    if (action === 'feedback') return feedback(directory, await inputJSON(options));
    if (action === 'revise') return reviseKnowledge(directory, root, await inputJSON(options));
    if (['select', 'explain'].includes(action)) return selectKnowledge(directory, root, { text: options.query || '', paths: options.path ? [options.path] : [], version: options.version });
    const { applyKnowledge, inspectKnowledge, recoverTransaction } = await import('../src/knowledge.mjs');
    if (action === 'inspect') return inspectKnowledge(directory, root, options.path);
    if (action === 'apply') return applyKnowledge(directory, await inputJSON(options));
    if (action === 'recover') return recoverTransaction(directory, options.transaction, root);
  }
  if (command === 'learning') {
    const { learningConfig, projectFor, setLearningConfig, setLearningEnabled } = await import('../src/learning-config.mjs');
    const { installSchedule, removeSchedule, schedulePreview, tick } = await import('../src/scheduler.mjs');
    if (action === 'config') {
      if (subaction === 'get') return learningConfig(directory, options.global ? null : await projectFor(directory, root));
      if (subaction === 'set') {
        const result = await setLearningConfig(directory, root, await inputJSON(options), options.global);
        const projects = Object.values((await readState(directory)).projects).filter(p => p.enabled && p.learning?.schedule);
        for (const p of projects) if (options.global || p.projectId === (await projectFor(directory, root)).projectId) await installSchedule(directory, p.root, p.learning.schedule.entry);
        return result;
      }
    }
    const { migrateCandidates } = await import('../src/learning.mjs');
    if (action === 'enable') { const result = await setLearningEnabled(directory, root, true); return { ...result, migration: await migrateCandidates(directory, root) }; }
    if (action === 'disable') return setLearningEnabled(directory, root, false);
    const { acknowledgeNotices, learningStatus, recoverReview, reviewOnce } = await import('../src/review.mjs');
    if (action === 'status') return learningStatus(directory, root);
    if (action === 'migrate') return migrateCandidates(directory, root);
    if (action === 'acknowledge') return acknowledgeNotices(directory, root);
    if (action === 'review') return reviewOnce(directory, root, { nowRequested: options.now });
    if (action === 'recover') return recoverReview(directory, root, options.run);
    if (action === 'tick') return tick(directory, root);
    if (action === 'doctor') {
      // --global 只看个人配置，接入前也能用；否则按项目配置覆盖后的最终值核对。
      const project = options.global ? null : await projectFor(directory, root);
      return (await import('../src/onboard.mjs')).learningDoctor(directory, project, { root: project?.root });
    }
    if (action === 'schedule') {
      if (subaction === 'preview') return schedulePreview(directory, root, cliPath());
      if (subaction === 'install') return installSchedule(directory, root, cliPath());
      if (subaction === 'remove') return removeSchedule(directory, root);
    }
  }
  if (command === 'pending') {
    if (action === 'create') return (await import('../src/knowledge.mjs')).createPending(directory, await inputJSON(options));
    const state = await readState(directory);
    const resolved = await resolveProject(state, root);
    if (!resolved) return { pending: [] };
    const list = Object.values(state.pending).filter(item => item.projectId === resolved.project.projectId && item.kind === 'knowledge-pending' && item.status === 'open');
    if (action === 'list') return { pending: list };
    if (action === 'inspect') {
      const pending = list.find(item => item.pendingId === options.pending);
      if (!pending) fail('PENDING', '待办不存在或不属于当前项目');
      return { pending };
    }
  }
  fail('COMMAND', '未知命令；使用 --help 查看支持入口');
}
try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, error: error.code || 'IO', message: error.message })}\n`); process.exitCode = 1; }
