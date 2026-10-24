import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stateDirectory } from './store.mjs';

// 模块真实位置。经 current 链接启动时 import.meta.url 已被解析成 releases/<版本> 路径。
export const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// 对外给出的入口沿用启动路径：hook 经 current 启动时，argv[1] 保留 current，升级后路径仍有效。
export const PUBLIC_ROOT = (() => {
  const script = process.argv[1];
  if (!script || path.basename(script) !== 'workflow.mjs') return PRODUCT_ROOT;
  const root = path.resolve(path.dirname(script), '..');
  try { return same(realpathSync(root), realpathSync(PRODUCT_ROOT)) ? root : PRODUCT_ROOT; } catch { return PRODUCT_ROOT; }
})();
export const cliPath = () => path.join(PUBLIC_ROOT, 'bin', 'workflow.mjs');
export const docPath = (...parts) => path.join(PUBLIC_ROOT, 'docs', ...parts);
export const PRODUCT_VERSION = (() => { try { return JSON.parse(readFileSync(path.join(PRODUCT_ROOT, 'package.json'), 'utf8')).version; } catch { return null; } })();
const slash = value => value.replaceAll('\\', '/');
// 给用户或代理的完整命令：PowerShell 可直接粘贴执行。
export function command(args, { stateDir } = {}) {
  const quote = value => /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `"${value}"`;
  const extra = stateDir && !same(path.resolve(stateDir), stateDirectory()) ? ['--state-dir', quote(slash(stateDir))] : [];
  return ['node', quote(slash(cliPath())), ...args.map(a => quote(path.isAbsolute(a) ? slash(a) : a)), ...extra].join(' ');
}
