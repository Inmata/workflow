import path from 'node:path';
import { atomicWrite, fail, mutate, readState, readText, withLock } from './store.mjs';
import { resolveProject } from './projects.mjs';
import { safePath } from './documents.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  pendingThreshold: 10, maxPendingAgeHours: 24, checkIntervalMinutes: 15,
  maxRunMinutes: 30, maxBatchItems: 10, maxRunsPerDay: 1, maxInputChars: 24000,
  retrievalLimit: 5, retrievalChars: 2500, model: null, reasoningEffort: null, profile: null,
  executor: 'codex', executorPath: 'codex', claudePath: 'claude', claudeSettings: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
export const EXECUTOR_NAMES = ['codex', 'claude'];
const ranges = { pendingThreshold: [1, 10000], maxPendingAgeHours: [1, 8760], checkIntervalMinutes: [1, 10080], maxRunMinutes: [1, 1440], maxBatchItems: [1, 500], maxRunsPerDay: [1, 1000], maxInputChars: [2000, 1000000], retrievalLimit: [1, 100], retrievalChars: [200, 50000] };
export function validateConfig(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('CONFIG', '配置必须是对象');
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) fail('CONFIG', '未知配置项 ' + key);
    if (ranges[key]) { const [min, max] = ranges[key]; if (!Number.isSafeInteger(value) || value < min || value > max) fail('CONFIG', key + ' 必须在 ' + min + ' 到 ' + max + ' 之间'); }
    else if (key === 'executor') { if (!EXECUTOR_NAMES.includes(value)) fail('CONFIG', 'executor 只能是 ' + EXECUTOR_NAMES.join(' 或 ')); }
    else if (key === 'claudeSettings') {
      if (value !== null && (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value))) fail('CONFIG', 'claudeSettings 必须是设置文件的绝对路径或 null');
    } else if (['model', 'profile', 'reasoningEffort'].includes(key)) {
      if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value))) fail('CONFIG', '无效配置 ' + key);
      if (key === 'profile' && value !== null && !/^[A-Za-z0-9_-]+$/.test(value)) fail('CONFIG', 'profile 只能包含字母、数字、下划线和连字符');
    } else if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) fail('CONFIG', '无效配置 ' + key);
  }
  const output = partial ? input : { ...DEFAULT_CONFIG, ...input };
  if (output.timeZone) try { new Intl.DateTimeFormat('en', { timeZone: output.timeZone }).format(); } catch { fail('CONFIG', '无效时区'); }
  return output;
}
async function configFile(file) {
  const raw = await readText(file);
  if (raw === null) return {};
  try { return validateConfig(JSON.parse(raw.replace(/^\uFEFF/, '')), true); } catch (e) { if (e.code) throw e; fail('CONFIG', '配置不是有效 JSON'); }
}
export async function projectFor(directory, root, state) {
  const resolved = await resolveProject(state || await readState(directory), root);
  if (!resolved) fail('PROJECT', '当前目录没有有效本机绑定');
  return resolved.project;
}
export async function learningConfig(directory, project) {
  const global = await configFile(path.join(directory, 'config.json'));
  const local = project ? await configFile(await safePath(project.knowledgeRoot, '.workflow/config.json', ['.json'])) : {};
  return { values: validateConfig({ ...global, ...local }), sources: Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(k => [k, Object.hasOwn(local, k) ? 'project' : Object.hasOwn(global, k) ? 'personal' : 'default'])) };
}
export async function setLearningConfig(directory, root, input, global = false) {
  validateConfig(input, true);
  const project = global ? null : await projectFor(directory, root);
  const file = global ? path.join(directory, 'config.json') : await safePath(project.knowledgeRoot, '.workflow/config.json', ['.json']);
  return withLock(directory, 'learning-config', async () => {
    const current = await configFile(file);
    const value = validateConfig({ ...current, ...input }, true);
    await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
    return { file, ...await learningConfig(directory, project), takesEffect: '下一次检查；运行中的作业沿用启动配置' };
  });
}
export async function setLearningEnabled(directory, root, enabled) {
  return mutate(directory, async state => {
    const project = await projectFor(directory, root, state);
    project.learning ||= {};
    project.learning.enabled = enabled;
    project.learning.permission = enabled ? '.workflow/knowledge/' : null;
    project.learning.changedAt = new Date().toISOString();
    return { projectId: project.projectId, enabled, permission: project.learning.permission };
  });
}
