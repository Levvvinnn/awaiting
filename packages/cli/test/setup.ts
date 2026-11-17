// Vitest setup for every cli test file: the real ~/.claude/settings.json must never be touched.
// HOME/USERPROFILE point at a throwaway dir so os.homedir() can't reach the real profile, and
// AWAITING_FORBID_REAL_SETTINGS=1 makes the CLI refuse the OS user's real settings path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awaiting-cli-home-'));
process.env['HOME'] = fakeHome;
process.env['USERPROFILE'] = fakeHome;
process.env['AWAITING_FORBID_REAL_SETTINGS'] = '1';
process.env['AWAITING_HOME'] = path.join(fakeHome, '.awaiting');

if (path.resolve(os.homedir()) === path.resolve(os.userInfo().homedir)) {
  throw new Error('test setup: os.homedir() still points at the real home directory');
}
