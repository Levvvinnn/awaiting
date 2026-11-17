// Executable entry, bundled by Vite to dist/awaiting.cjs (plan 01 §3.10, D1.12).
import os from 'node:os';
import path from 'node:path';
import { run } from './run';

function cliDir(): string {
  // CJS bundle: __filename is the bundle. Fallback: the script node was started with.
  if (typeof __filename === 'string') return path.dirname(__filename);
  return path.dirname(path.resolve(process.argv[1] ?? '.'));
}

run(process.argv.slice(2), {
  env: process.env,
  homedir: os.homedir(),
  now: () => Date.now(),
  stdout: process.stdout,
  stderr: process.stderr,
  cliDir: cliDir(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`awaiting: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
