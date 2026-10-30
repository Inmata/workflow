import path from 'node:path';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { canonical, digest, fail, mutate, readState, readText, samePath } from './store.mjs';
import { agentsFile, blockFrom, disableProject, enableProject, identity, identityEqual } from './projects.mjs';
import { installRecord, releaseIntegrity } from './install.mjs';
import { learningConfig, setLearningEnabled } from './learning-config.mjs';
import { scanAlignment } from './alignment.mjs';
import { migrateCandidates } from './learning.mjs';
import { installSchedule } from './scheduler.mjs';
import { EXECUTORS, runProcess } from './runner.mjs';
import { HOSTS } from './hooks.mjs';
import { PRODUCT_ROOT, PRODUCT_VERSION, cliPath, command } from './entry.mjs';

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
  const reinstall = agent => command(['install', '--agent', agent], { stateDir: directory, cli: path.join(PRODUCT_ROOT, 'bin', 'workflow.mjs') });
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

// 学习结果单独成形：调用方据此区分“核心接入完成”和“可选学习未启用”，不把学习失败写成全部成功。
function learningResult(learning, { requested, enabled, schedule, failure } = {}) {
  if (!learning) return { status: 'skipped', requested: false };
  return {
    status: learning.status,
    requested,
    ...(enabled === undefined ? {} : { enabled }),
    ...(schedule ? { schedule } : {}),
    ...(failure ? { failure } : {}),
    executor: learning.executor,
    model: learning.model,
    ...(learning.executor === 'codex' ? { profile: learning.profile } : { claudeSettings: learning.claudeSettings }),
    ...(learning.error ? { error: learning.error } : {}),
    ...(learning.message ? { message: learning.message } : {}),
  };
}
// 学习登记状态按实际读取：重复接入或启用失败时，既有开关和计划任务可能仍然有效。
function registeredLearning(previous) {
  return {
    enabled: previous?.learning?.enabled === true,
    schedule: previous?.learning?.schedule?.taskName || 'not-registered',
  };
}
async function currentLearning(directory, projectId) {
  const project = (await readState(directory)).projects?.[projectId];
  return registeredLearning(project);
}
// 一步接入：核心检查全部通过才写入；可选学习预检单独报告，未请求启用时只提示，不阻断核心接入。
// 核心检查未通过时不读取也不执行个人/项目配置指定的执行器，避免用未获批的配置先跑进程。
export async function onboardProject(directory, root, options = {}) {
  root = await canonical(root);
  const state = await readState(directory);
  const install = options.allowUninstalled ? [] : await installProblems(directory, state);
  const binding = await bindingProblems(directory, state, root);
  const problems = [...install, ...binding.problems];
  const learningRequested = Boolean(options.enableLearning) && !options.skipLearning;
  if (problems.length) {
    const learning = options.skipLearning ? learningResult(null) : { status: 'not-run', requested: learningRequested, enabled: false, reason: 'core-blocked' };
    return { status: 'blocked', root, written: false, problems, learning, warnings: [] };
  }
  const learning = options.skipLearning ? null : await learningDoctor(directory, { projectId: binding.previous?.projectId, knowledgeRoot: root }, { root, execute: options.execute });
  const learningReady = Boolean(learning && learning.status === 'capabilities-verified');
  const learningCommands = [
    command(['learning', 'doctor', '--global'], { stateDir: directory }),
    command(['project', 'onboard', '--root', root, '--enable-learning'], { stateDir: directory }),
  ];
  const report = extra => learningResult(learning, { requested: learningRequested, ...extra });
  const enabled = await enableProject(directory, root, { coexistenceMode: options.coexistenceMode });
  const scanned = await scanAlignment(directory, root);
  if (options.skipLearning) await setLearningEnabled(directory, root, false);
  const next = [];
  const previousLearning = registeredLearning(binding.previous);
  const alreadyLearning = previousLearning.enabled;
  const preflightReason = learning?.message || learning?.error || learning?.status;
  let learningOutcome;
  if (options.skipLearning) learningOutcome = { status: 'skipped', requested: false };
  else if (learningRequested) {
    if (!learningReady) {
      // 显式请求学习但预检未过：核心接入照常完成；既有学习登记保持不变，只报告本次预检失败。
      learningOutcome = report({
        enabled: alreadyLearning,
        schedule: alreadyLearning ? previousLearning.schedule : 'not-registered',
        failure: 'preflight',
      });
      next.push({
        step: alreadyLearning
          ? `核心接入已完成。本次执行器预检未通过（${preflightReason}），未改动现有后台复盘登记：仍为已启用（计划任务 ${previousLearning.schedule}）。修好后可重新执行 --enable-learning 核对`
          : `核心接入已完成，但后台复盘未启用：执行器预检未通过（${preflightReason}）。修好后重新执行 --enable-learning`,
        commands: learningCommands,
      });
    } else {
      const attempted = await enableLearning(directory, root, options);
      // 失败时按状态文件里的实际登记报告，不把既有开关或计划任务写成未启用。
      const registration = attempted.status === 'enabled' ? { enabled: true, schedule: attempted.schedule } : await currentLearning(directory, enabled.projectId);
      learningOutcome = report({ ...registration, ...(attempted.status === 'enabled' ? {} : { failure: attempted.status }) });
      if (attempted.status !== 'enabled') next.push({ step: `后台复盘未完全启用：${attempted.message}修好后补跑`, commands: attempted.commands });
    }
  } else {
    learningOutcome = report(alreadyLearning ? { enabled: true, schedule: previousLearning.schedule } : { enabled: false });
    // 已启用学习的项目保持原登记，不因本次预检失败提示“未启用”，也不再建议重复启用。
    if (!alreadyLearning && !learningReady) next.push({ step: `核心接入已完成，后台复盘未启用：执行器预检未通过（${preflightReason}）。这不影响核心接入；修好后可加 --enable-learning 启用`, commands: learningCommands });
    // 是否拦截取决于当前宿主的实际权限；保留用户终端入口，不把代理执行一律说成会被拦截。
    else if (!alreadyLearning) next.push({ step: '启用后台复盘（会按配置真实调用模型并消耗额度，需用户同意）。可在你自己的终端执行，也可在当前会话权限允许时由代理直接执行', commands: [command(['project', 'onboard', '--root', root, '--enable-learning'], { stateDir: directory })] });
  }
  next.push({ step: '在项目目录开一个新会话。hook 会注入 workflow 入口，Lead 按 alignmentGuide 完成项目对齐。' });
  // 显式请求学习但未完整生效时用 partial 标记：核心接入字段照常保留，调用方可据此返回非零退出码。
  const learningSatisfied = !learningRequested || (!learningOutcome.failure && learningOutcome.enabled === true);
  return {
    status: learningSatisfied ? 'onboarded' : 'partial', root, written: true, projectId: enabled.projectId, agentsChanged: enabled.agentsChanged,
    alignment: { docPath: scanned.docPath, indexedFiles: scanned.files.length, truncated: scanned.truncated },
    learning: learningOutcome,
    warnings: learning?.warnings || [], next,
  };
}

// 启用学习后注册计划任务；任一步失败不回退接入，只报告原因和补跑命令。
async function enableLearning(directory, root, { execute = runProcess } = {}) {
  const run = args => command([...args, '--root', root], { stateDir: directory });
  try {
    await setLearningEnabled(directory, root, true);
    await migrateCandidates(directory, root);
  } catch (error) {
    return { status: 'failed', message: error.message, commands: [run(['learning', 'enable']), run(['learning', 'schedule', 'install'])] };
  }
  if (process.platform !== 'win32') return { status: 'enabled', schedule: 'not-applicable' };
  try {
    const registered = await installSchedule(directory, root, cliPath(), execute);
    return { status: 'enabled', schedule: registered.taskName };
  } catch (error) {
    return { status: 'schedule-failed', message: `学习已启用，计划任务注册失败（${error.code || 'SCHEDULER'}：${error.message}）。`, commands: [run(['learning', 'schedule', 'install']), run(['learning', 'status'])] };
  }
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
