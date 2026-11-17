// `awaiting uninstall` (plan 01 §3.10): removes only our handlers; backup before the write.
import type { ParsedArgs } from '../args';
import { hookDirFor, purgeHook } from '../hook-copy';
import { dataDirFor } from '../paths';
import type { CommandContext } from '../run';
import { readSettings, serializeSettings, writeSettings } from '../settings/io';
import { needsWrite, planUninstall } from '../settings/merge';

export function uninstall(args: ParsedArgs, ctx: CommandContext): number {
  const { settingsPath, stdout, stderr } = ctx;
  const read = readSettings(settingsPath);
  if (read.kind === 'malformed') {
    stderr.write(
      `awaiting: ${settingsPath} is malformed (${read.error}).\n` +
        `Nothing was written. Fix the file by hand, then run uninstall again.\n`,
    );
    return 1;
  }

  let changed = false;
  if (read.kind === 'missing') {
    stdout.write(`Settings: ${settingsPath} does not exist; nothing to remove.\n`);
  } else {
    const { value, changes } = planUninstall(read.value);
    stdout.write(`Settings: ${settingsPath}\n`);
    for (const c of changes) stdout.write(`  removed   ${c.event} (${c.count})\n`);
    changed = needsWrite(changes);
    if (!changed) stdout.write('No awaiting entries found; nothing to remove.\n');
    if (changed && !args.dryRun) {
      const { backup } = writeSettings(
        settingsPath,
        serializeSettings(value, read),
        read,
        ctx.now(),
      );
      if (backup !== null) stdout.write(`Backup:   ${backup}\n`);
      stdout.write(`Updated ${settingsPath}\n`);
    }
  }

  const dataDir = dataDirFor(ctx.env, ctx.homedir);
  if (args.purge) {
    if (args.dryRun) {
      stdout.write(`Would delete the hook copy in ${hookDirFor(dataDir)}\n`);
    } else {
      for (const f of purgeHook(dataDir)) stdout.write(`Deleted ${f}\n`);
    }
  }
  if (args.dryRun) stdout.write('Dry run: nothing was written.\n');
  return 0;
}
