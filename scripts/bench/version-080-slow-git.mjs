// Same injection boundary as test/hooks.test.mjs F05; real Git still runs after delay.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const real = cp.spawnSync.bind(cp);
let first = true;
cp.spawnSync = (command, args = [], options = {}) => {
  if (command !== 'git' || !args.includes('--literal-pathspecs')) return real(command, args, options);
  if (first) { first = false; process.stderr.write('SPEC-BEGIN\n'); }
  const hang = process.env.BENCH_DELAY === 'hang';
  const delay = hang ? Number(options.timeout) : 350;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  if (hang) return { status: null, signal: null, error: Object.assign(new Error('injected timeout'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };
  return real(command, args, options);
};
syncBuiltinESMExports();
