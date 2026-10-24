import path from 'node:path';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { canonical, digest, fail, mutate, readState, readText, samePath } from './store.mjs';
import { agentsFile, blockFrom, disableProject, enableProject, identity, identityEqual } from './projects.mjs';
import { installRecord, releaseIntegrity } from './install.mjs';
import { learningConfig, setLearningEnabled } from './learning-config.mjs';
import { scanAlignment } from './alignment.mjs';
import { EXECUTORS, runProcess } from './runner.mjs';
import { HOSTS } from './hooks.mjs';
import { PRODUCT_ROOT, PRODUCT_VERSION, command } from './entry.mjs';

const slash = value => value.replaceAll('\\', '/');
const base64 = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const CLAUDE_SETTINGS = directory => slash(path.join(directory, 'claude-learning.json'));
const CODEX_PROFILE = 'workflow-learning';

// 专用配置缺失时给出建立方法；继承前台配置只在用户明确选择后才算正常。
function dedicatedWarnings(values, directory) {
  const set = value => command(['learning', 'config', 'set', '--global', '--base64', base64(value)], { stateDir: directory });
  if (values.executor === 'claude' && !values.claudeSettings) {
    const file = CLAUDE_SETTINGS(directory);
    return [{ code: 'CLAUDE_SETTINGS', message: `Claude 执行器未设 claudeSettings，后台复盘会继承 ~/.claude/settings.json 的网关、密钥和模型。建议新建专用设置文件 ${file}，内容形如 {"env":{"ANTHROPIC_BASE_URL":"<网关>","ANTHROPIC_API_KEY":"<密钥>"},"model":"<模型>"}（不能含 hooks、enabledPlugins、mcpServers，密钥只放这里），再执行下面的命令登记。确实要继承前台配置时可忽略此项。`, command: set({ claudeSettings: file }) }];
  }
  if (values.executor === 'codex' && !values.profile) {
    const file = slash(path.join(os.homedir(), '.codex', `${CODEX_PROFILE}.config.toml`));
    return [{ code: 'CODEX_PROFILE', message: `Codex 执行器未设 profile，后台复盘会沿用 ~/.codex/config.toml 的 provider 和模型。建议新建 ${file}（写 model_provider 和 model 两行），再执行下面的命令登记。确实要继承主配置时可忽略此项。`, command: set({ profile: CODEX_PROFILE }) }];
  }
  return [];
}

// 只做能力核对，不调用模型；失败时返回原因而不是抛出，便于和其他检查一起列出。
export async function learningDoctor(directory, project, { root, execute = runProcess } = {}) {
  let config;
  try { config = await learningConfig(directory, project); }
  catch (error) { return { status: 'config-invalid', modelInvocation: false, error: error.code || 'CONFIG', message: error.message, warnings: [] }; }
  const { values, sources } = config;
  const runDir = path.join(directory, project?.projectId ? path.join('projects', project.projectId) : 'global', 'preflight');
  const base = {
    modelInvocation: false, executor: values.executor, model: values.model || '沿用 CLI 配置',
    ...(values.executor === 'codex' ? { profile: values.profile } : { claudeSettings: values.claudeSettings }),
    sources: { executor: sources.executor, model: sources.model, profile: sources.profile, claudeSettings: sources.claudeSettings },
    warnings: dedicatedWarnings(values, directory), dataDirectory: directory,
  };
  try {
    const capability = await EXECUTORS[values.executor].preflight(values, runDir, execute);
    return { status: capability.status, ...base };
  } catch (error) {
    const fix = values.executor === 'claude' ? 'claudePath 应指向 claude.exe 的绝对路径，claudeSettings 文件须存在且为 JSON' : 'executorPath 应指向 codex 可执行文件，profile 名称须对应 ~/.codex/<名称>.config.toml';
    return { status: 'failed', error: error.code || 'EXECUTOR', message: `${error.message}（${fix}）`, ...base, ...(root ? { configCommand: command(['learning', 'config', 'get', '--root', root], { stateDir: directory }) } : {}) };
  }
}

async function installProblems(directory, state) {
  const problems = [];
  const records = HOSTS.map(agent => [agent, installRecord(state, agent)]).filter(([, record]) => record?.status === 'installed');
  const reinstall = agent => `node "${slash(path.join(PRODUCT_ROOT, 'bin', 'workflow.mjs'))}" install --agent ${agent}`;
  if (!records.length) problems.push({ code: 'NOT_INSTALLED', message: '没有任何宿主安装本插件，接入后 hook 不会触发。在插件仓库目录执行安装（按实际使用的宿主选一条或两条）。', commands: HOSTS.map(reinstall) });
  for (const [agent, record] of records) {
    const integrity = await releaseIntegrity(directory, record);
    if (integrity !== 'verified') problems.push({ code: 'INTEGRITY', message: `${agent} 的安装副本不完整或 current 链接未指向登记版本，hook 会被保守放行。`, commands: [reinstall(agent)] });
    else if (PRODUCT_VERSION && record.version !== PRODUCT_VERSION) problems.push({ code: 'VERSION', message: `${agent} 已安装 ${record.version}，当前运行的是 ${PRODUCT_VERSION}。hook 会按旧版本工作，先重装。`, commands: [reinstall(agent)] });
  }
  return problems;
}

async function bindingProblems(directory, state, root) {
  const problems = [];
  const previous = Object.values(state.projects).find(p => samePath(p.root, root));
  try {
    const current = await identity(root);
    if (previous?.enabled && !identityEqual(previous.identity, current)) problems.push({ code: 'IDENTITY', message: '目录或 Git 身份与已登记绑定不同（目录被移动或重建）。先清除旧绑定再接入。', commands: [command(['project', 'remove', '--root', root], { stateDir: directory })] });
  } catch (error) { problems.push({ code: error.code || 'GIT_UNAVAILABLE', message: error.message }); }
  try {
    const original = await readText(await agentsFile(root), '');
    const block = blockFrom(original);
    if (block && (!previous || digest(block.content) !== previous.managedBlockHash)) problems.push({ code: 'AGENTS', message: `AGENTS.md 里有未登记或被改过的 workflow 管理区（复制来的或旧接入残留）。删除 ${slash(path.join(root, 'AGENTS.md'))} 中 <!-- workflow:begin --> 到 <!-- workflow:end --> 之间（含这两行）的内容后重试。` });
  } catch (error) { problems.push({ code: error.code || 'AGENTS', message: error.message }); }
  return { problems, previous };
}

// 一步接入：先做全部检查，任何一项不过都不写入，并一次列出所有问题和修复命令。
export async function onboardProject(directory, root, options = {}) {
  root = await canonical(root);
  const state = await readState(directory);
  const install = options.allowUninstalled ? [] : await installProblems(directory, state);
  const binding = await bindingProblems(directory, state, root);
  const learning = options.skipLearning ? null : await learningDoctor(directory, { projectId: binding.previous?.projectId, knowledgeRoot: root }, { root, execute: options.execute });
  const problems = [...install, ...binding.problems];
  if (learning && !['capabilities-verified'].includes(learning.status)) problems.push({ code: 'LEARNING', message: `后台复盘执行器预检未通过：${learning.message} 修好配置后重试；不打算启用后台复盘时，加 --skip-learning 接入。`, commands: [command(['learning', 'doctor', '--global'], { stateDir: directory }), command(['project', 'onboard', '--root', root, '--skip-learning'], { stateDir: directory })] });
  if (problems.length) return { status: 'blocked', root, written: false, problems, warnings: learning?.warnings || [] };
  const enabled = await enableProject(directory, root, { owner: options.owner, coexistenceMode: options.coexistenceMode });
  const scanned = await scanAlignment(directory, root);
  if (options.skipLearning) await setLearningEnabled(directory, root, false);
  const run = args => command([...args, '--root', root], { stateDir: directory });
  const next = [];
  if (!options.skipLearning) next.push({ step: '启用后台复盘（会按配置真实调用模型并消耗额度，需用户同意）', commands: [run(['learning', 'enable']), run(['learning', 'schedule', 'install']), run(['learning', 'status'])] });
  next.push({ step: '在项目目录开一个新会话。hook 会注入 workflow 入口，Lead 按 alignmentGuide 完成项目对齐。' });
  return {
    status: 'onboarded', root, projectId: enabled.projectId, agentsChanged: enabled.agentsChanged,
    alignment: { docPath: scanned.docPath, indexedFiles: scanned.files.length, truncated: scanned.truncated },
    learning: learning ? { status: learning.status, executor: learning.executor, model: learning.model, ...(learning.executor === 'codex' ? { profile: learning.profile } : { claudeSettings: learning.claudeSettings }) } : { status: 'skipped' },
    warnings: learning?.warnings || [], next,
  };
}

async function deleteSchedule(schedule, execute) {
  if (!schedule?.taskName) return 'not-registered';
  const result = await execute('schtasks.exe', ['/Delete', '/TN', schedule.taskName, '/F'], {});
  if (result.code === 0) return 'removed';
  const query = await execute('schtasks.exe', ['/Query', '/TN', schedule.taskName], {});
  if (query.code !== 0) return 'already-absent';
  fail('SCHEDULER', `计划任务 ${schedule.taskName} 删除失败，项目记录保留；可手动执行 schtasks.exe /Delete /TN ${schedule.taskName} /F 后重试`);
}

// 清除本机绑定：计划任务、AGENTS 管理区、状态记录和本机数据目录。项目里的对齐文件和 .workflow/ 是用户资料，只列出不删除。
export async function removeProject(directory, root, { execute = runProcess } = {}) {
  root = await canonical(root);
  const state = await readState(directory);
  const project = Object.values(state.projects).find(p => samePath(p.root, root));
  if (!project) fail('PROJECT', '该目录没有本机绑定记录，无需清除');
  const projectId = project.projectId;
  const schedule = process.platform === 'win32' ? await deleteSchedule(project.learning?.schedule, execute) : 'not-applicable';
  const agents = await disableProject(directory, root).catch(error => ({ agentsChanged: false, conflict: error.message }));
  const removed = await mutate(directory, async current => {
    const counts = { sessions: 0, tasks: 0, pending: 0, transactions: 0 };
    for (const key of Object.keys(counts)) {
      for (const [name, item] of Object.entries(current[key] || {})) if (item?.projectId === projectId) { delete current[key][name]; counts[key]++; }
    }
    delete current.projects[projectId];
    return counts;
  });
  await rm(path.join(directory, 'projects', projectId), { recursive: true, force: true });
  let records = 0;
  const changes = path.join(directory, 'project-changes');
  for (const name of await readdir(changes).catch(() => [])) {
    const file = path.join(changes, name);
    try { if (JSON.parse(await readFile(file, 'utf8')).projectId === projectId) { await rm(file, { force: true }); records++; } } catch { /* 无法辨认的记录保留 */ }
  }
  const kept = [];
  for (const relative of [project.alignment?.docPath, 'docs/WORKFLOW-ALIGNMENT.md', 'WORKFLOW-ALIGNMENT.md', '.workflow']) {
    if (!relative || kept.some(item => item.path === relative)) continue;
    if (await lstat(path.join(root, relative)).catch(() => null)) kept.push({ path: relative, absolute: slash(path.join(root, relative)) });
  }
  return {
    status: 'removed', projectId, root, schedule, agentsChanged: Boolean(agents.agentsChanged),
    ...(agents.conflict ? { agentsConflict: `${agents.conflict}；请手动删除 AGENTS.md 中 workflow 管理区` } : {}),
    state: removed, projectChanges: records,
    kept, note: kept.length ? '以上是项目内的用户资料（对齐文件、知识库、项目配置），未删除；不再需要时自行删除。' : '项目内没有遗留的 workflow 资料。',
  };
}
