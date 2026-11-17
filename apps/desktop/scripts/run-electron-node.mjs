// Run a Node script inside Electron's runtime (ELECTRON_RUN_AS_NODE=1), forwarding its exit
// code. A Node launcher avoids `VAR=1 cmd` syntax, which cmd.exe on Windows does not support.
// Usage: node scripts/run-electron-node.mjs <script> [args...]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const TIMEOUT_MS = 30_000;
const [script, ...args] = process.argv.slice(2);
if (script === undefined) {
  console.error('usage: run-electron-node.mjs <script> [args...]');
  process.exit(2);
}

/** Required from Node, the `electron` package returns the path to the Electron binary. */
const electronPath = /** @type {string} */ (createRequire(import.meta.url)('electron'));

const child = spawn(electronPath, [resolve(script), ...args], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});

const timer = setTimeout(() => {
  console.error(`run-electron-node: ${script} timed out after ${TIMEOUT_MS} ms`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error('run-electron-node: failed to start Electron:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (signal !== null) console.error(`run-electron-node: ${script} killed by ${signal}`);
  process.exit(code ?? 1);
});
