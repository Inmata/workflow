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
const PLAIN = /^[A-Za-z0-9_./:=-]+$/;
// 目标 shell 是 PowerShell：单引号内不做变量、子表达式或反引号展开，内部单引号加倍。
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const shQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
const shellQuote = process.platform === 'win32' ? psQuote : shQuote;
// 只按目标 shell 的字面量规则引用一个值，不做 5.1 传输编码；用于必须保持原位的入口路径。
export const shellValue = value => PLAIN.test(slash(value)) ? slash(value) : shellQuote(slash(value));
// Windows PowerShell 5.1 调用原生程序时不会转义参数里的双引号，也会丢弃空参数；只靠引号无法表达。
// 这类值编码成只含安全字符的标记，由 command() 同时追加传输开关，CLI 启动时才还原。
// 直接调用时用户手写的同名文本没有开关，保持原样，不因长得像标记就被改写。
const ARG_MARK = 'workflow-arg64:';
const encodeArgument = value => ARG_MARK + Buffer.from(value, 'utf8').toString('base64url');
const needsEncoding = value => value === '' || value.includes('"') || value.startsWith(ARG_MARK) || (/\s/.test(value) && value.endsWith('\\'));
// 传输开关只出现在 command() 生成的命令里；不是公开参数，解析前由 transportArguments 移除。
export const TRANSPORT_FLAG = '--workflow-arg64-transport';
export function decodeArgument(value) {
  if (typeof value !== 'string' || !value.startsWith(ARG_MARK)) return value;
  const payload = value.slice(ARG_MARK.length);
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  // 非法标记原样保留，避免把用户手写的相似字符串误当成编码值。
  return Buffer.from(decoded, 'utf8').toString('base64url') === payload ? decoded : value;
}
export const decodeArguments = argv => argv.map(decodeArgument);
// bin 入口用本函数解析命令行：只有生成命令带的开关才启用还原，并先移除开关本身。
export function transportArguments(argv) {
  const index = argv.indexOf(TRANSPORT_FLAG);
  if (index < 0) return [...argv];
  return argv.filter((_, position) => position !== index).map(decodeArgument);
}
// 给用户或代理的完整命令：PowerShell 可直接粘贴执行；特殊参数只按字面值传递。
export function command(args, { stateDir, cli = cliPath() } = {}) {
  let transported = false;
  const quote = value => {
    if (process.platform === 'win32' && needsEncoding(value)) { transported = true; return encodeArgument(value); }
    return PLAIN.test(value) ? value : shellQuote(value);
  };
  const extra = stateDir && !same(path.resolve(stateDir), stateDirectory()) ? ['--state-dir', quote(slash(stateDir))] : [];
  const parts = ['node', quote(slash(cli)), ...args.map(a => quote(path.isAbsolute(a) ? slash(a) : a)), ...extra];
  // 没编码任何参数时不带开关，命令保持原有形状；带了开关才在启动时还原标记。
  if (transported) parts.push(TRANSPORT_FLAG);
  return parts.join(' ');
}
