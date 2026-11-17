// Timestamped settings.json backups (plan 01 §3.10 Write step 2, D1.11). Kept forever.
import fs from 'node:fs';

/** `YYYYMMDDTHHmmssSSSZ` in UTC (no colons, Windows-safe, sortable). */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:.]/g, '');
}

/** Copies the raw bytes of `file` to `<file>.awaiting-backup-<stamp>[-N]`; never overwrites. */
export function createBackup(file: string, now: number): string {
  const base = `${file}.awaiting-backup-${backupStamp(now)}`;
  for (let n = 1; n < 1000; n++) {
    const target = n === 1 ? base : `${base}-${n}`;
    try {
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not find a free backup name for ${file}`);
}
