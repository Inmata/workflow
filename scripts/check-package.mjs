import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLAUDE_EVENTS, EVENTS } from '../src/hooks.mjs';
import { RELEASE_PATHS } from '../src/install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const check = (condition, reason) => { if (!condition) errors.push(reason); };
async function walk(relative) {
  const result = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, item.name);
    if (item.isDirectory()) result.push(...await walk(file)); else result.push(file);
  }
  return result;
}
const json = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const info = await json('package.json');
check(Number(process.versions.node.split('.')[0]) >= 24, '需要 Node.js 24+');
check(!Object.keys(info.dependencies || {}).length, '首版不能引入运行时第三方依赖');
check(JSON.stringify([...info.files].sort()) === JSON.stringify([...RELEASE_PATHS].sort()), 'npm files 与安装发布白名单不一致');
const releaseFiles = new Set();
for (const relative of RELEASE_PATHS) {
  const files = (await lstat(path.join(root, relative))).isDirectory() ? await walk(relative) : [relative];
  for (const file of files) releaseFiles.add(path.resolve(root, file));
}
for (const relative of ['plugin.json', '.codex-plugin/plugin.json']) {
  const plugin = await json(relative);
  check(plugin.version === info.version, `版本不一致：${relative}`);
  check(plugin.name === 'workflow', `插件名称不一致：${relative}`);
  check(!plugin.hooks, `用户 hooks 唯一注册，不能重复启用插件 hooks：${relative}`);
}
const hooks = await json('hooks/codex.json');
check(JSON.stringify(Object.keys(hooks.hooks).sort()) === JSON.stringify([...EVENTS].sort()), 'hook 事件声明不一致');
check(hooks.hooks.Interrupt[0].hooks[0].timeout <= 3, 'Interrupt 超时超过宿主限制');
const claudeHooks = await json('hooks/claude.json');
check(JSON.stringify(Object.keys(claudeHooks.hooks).sort()) === JSON.stringify([...CLAUDE_EVENTS].sort()), 'Claude hook 事件声明不一致');
check(claudeHooks.hooks.PostToolUse[0].hooks[0].args?.includes('--agent') && claudeHooks.hooks.PostToolUse[0].hooks[0].args?.includes('claude'), 'Claude hook 模板缺少宿主参数');
const codeFiles = [...await walk('src'), ...await walk('bin'), ...await walk('scripts'), ...await walk('test'), ...await walk('examples')].filter(file => file.endsWith('.mjs'));
for (const relative of codeFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  check(result.status === 0, `语法错误：${relative} ${result.stderr}`);
}
const documents = [...await walk('docs'), ...await walk('examples'), 'README.md', 'README.en.md'].filter(file => file.endsWith('.md'));
let links = 0;
for (const relative of documents) {
  const text = await readFile(path.join(root, relative), 'utf8');
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\r\n]*`/g, '');
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|app:|plugin:|#)/i.test(target)) continue;
    target = decodeURIComponent(target.split('#')[0]).replace(/:\d+$/, '');
    if (!target) continue;
    links++;
    const resolved = path.resolve(root, path.dirname(relative), target);
    try { await lstat(resolved); }
    catch { errors.push(`失效链接：${relative} → ${match[1]}`); }
    if (releaseFiles.has(path.resolve(root, relative))) check(releaseFiles.has(resolved), `发布副本缺少链接目标：${relative} → ${match[1]}`);
  }
}
const runtimeFiles = await walk('src');
for (const relative of runtimeFiles) {
  const text = await readFile(path.join(root, relative), 'utf8');
  check(!/(?:from\s+['"][^'"]*document-learning|import\(['"][^'"]*document-learning)/.test(text), `不能导入参考插件运行库：${relative}`);
}
const output = { ok: !errors.length, version: info.version, syntaxFiles: codeFiles.length, documents: documents.length, releaseFiles: releaseFiles.size, localLinks: links, errors };
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
if (errors.length) process.exitCode = 1;
