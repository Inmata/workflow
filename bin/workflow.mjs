#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fail, readState, stateDirectory } from '../src/store.mjs';
import { enableProject, disableProject, attachWorktree, resolveProject, setOwner } from '../src/projects.mjs';
import { getContext } from '../src/context.mjs';
import { applyKnowledge, createPending, inspectKnowledge, recoverTransaction } from '../src/knowledge.mjs';
import { handleHook } from '../src/hooks.mjs';
import { AGENTS, doctor, install, uninstall } from '../src/install.mjs';

const allowed = new Set(['state-dir', 'user-dir', 'root', 'project', 'role', 'session', 'input', 'base64', 'agent', 'owner', 'coexistence-mode', 'transaction', 'pending', 'help']);
function argumentsFor(argv) {
  const options = {}, commands = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) { commands.push(value); continue; }
    const key = value.slice(2);
    if (!allowed.has(key) || Object.hasOwn(options, key)) fail('ARGUMENT', `未知或重复参数 --${key}`);
    if (key === 'help') { options.help = true; continue; }
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
    'project enable --root <目录> [--owner <sessionId>] [--coexistence-mode bounded|pending-only]',
    'project disable --root <目录>', 'project attach-worktree --project <projectId> --root <目录>',
    'project owner --project <projectId> --session <sessionId>',
    'context --role lead|worker|reviewer [--project <目录>] [--session <sessionId>]',
    'signal --input <JSON文件> | --base64 <UTF-8 JSON>',
    'knowledge inspect --path <资料路径> [--project <目录>]',
    'knowledge apply --input <JSON文件>', 'knowledge recover --transaction <id> [--project <目录>]',
    'pending list [--project <目录>]', 'pending inspect --pending <id> [--project <目录>]', 'pending create --input <JSON文件>',
    'hook --agent codex|claude（stdin 为宿主事件）',
  ],
  note: 'signal 只输出，需当前宿主 PostToolUse 接受；未知状态、提问和中断不发补偿。不会自动提交或发布。',
};
// --path is a document-only option; it is never used to construct shell commands.
allowed.add('path');
async function main() {
  const { options, commands } = argumentsFor(process.argv.slice(2));
  const [command, action] = commands;
  if (options.help || !command) return help;
  if (commands.length > (['project', 'knowledge', 'pending'].includes(command) ? 2 : 1)) fail('ARGUMENT', '命令后存在多余的位置参数');
  const agent = options.agent || 'codex';
  if (!AGENTS.includes(agent)) fail('AGENT', `未知宿主 ${agent}；支持 ${AGENTS.join('/')}`);
  const directory = stateDirectory(options['state-dir']);
  const root = options.root || options.project || process.cwd();
  if (command === 'signal') return { workflow_signal: await inputJSON(options) };
  if (command === 'hook') {
    try { return await handleHook(directory, await inputJSON(options), { agent }); }
    catch { return { systemMessage: 'workflow 事件输入无效，已保守放行。' }; }
  }
  if (command === 'install') return install(directory, { userDir: options['user-dir'], agent });
  if (command === 'uninstall') return uninstall(directory, { agent });
  if (command === 'doctor') return doctor(directory, options.project, { agent });
  if (command === 'context') return getContext(directory, root, options.role || 'lead', options.session);
  if (command === 'project') {
    if (action === 'enable') { if (!options.root) fail('ARGUMENT', 'enable 需要明确 --root'); return enableProject(directory, options.root, { owner: options.owner, coexistenceMode: options['coexistence-mode'] }); }
    if (action === 'disable') { if (!options.root) fail('ARGUMENT', 'disable 需要明确 --root'); return disableProject(directory, options.root); }
    if (action === 'attach-worktree') { if (!options.project || !options.root) fail('ARGUMENT', '需要明确 --project ID 和 --root'); return attachWorktree(directory, options.project, options.root); }
    if (action === 'owner') return setOwner(directory, options.project, options.session);
  }
  if (command === 'knowledge') {
    if (action === 'inspect') return inspectKnowledge(directory, root, options.path);
    if (action === 'apply') return applyKnowledge(directory, await inputJSON(options));
    if (action === 'recover') return recoverTransaction(directory, options.transaction, root);
  }
  if (command === 'pending') {
    if (action === 'create') return createPending(directory, await inputJSON(options));
    const state = await readState(directory);
    const resolved = await resolveProject(state, root);
    if (!resolved) return { pending: [] };
    const list = Object.values(state.pending).filter(item => item.projectId === resolved.project.projectId && item.kind === 'knowledge-pending' && item.status === 'open');
    if (action === 'list') return { pending: list.slice(0, 1) };
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
