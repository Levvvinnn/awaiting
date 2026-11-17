// Full-app smoke test: launch the built app (out/) with AWAITING_SMOKE=1 and require exit 0
// plus a stdout line starting with AWAITING_SMOKE_OK. See src/main/smoke.ts.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 60_000;
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = /** @type {string} */ (createRequire(import.meta.url)('electron'));

const env = { ...process.env, AWAITING_SMOKE: '1' };
// Never inherit these: the smoke must run the real app against the production build.
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const child = spawn(electronPath, [appDir], {
  cwd: appDir,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});

let stdout = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});

const timer = setTimeout(() => {
  console.error(`smoke:app FAIL timed out after ${TIMEOUT_MS} ms`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error('smoke:app FAIL could not start Electron:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const ok = stdout.split(/\r?\n/).some((line) => line.startsWith('AWAITING_SMOKE_OK'));
  if (code === 0 && ok) {
    console.log('smoke:app ok');
    process.exit(0);
  }
  console.error(`smoke:app FAIL exit=${code} signal=${signal} okLine=${ok}`);
  process.exit(1);
});
