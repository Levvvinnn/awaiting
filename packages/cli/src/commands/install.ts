// `awaiting install` (plan 01 §3.10). Order: read + validate (abort on malformed, no write),
// plan the merge, then copy the hook, then back up and write settings.json only if needed.
import fs from 'node:fs';
import path from 'node:path';
import type { ParsedArgs } from '../args';
import { copyHook, findHookSource, installedHookPath } from '../hook-copy';
import { dataDirFor, hookSourceCandidates } from '../paths';
import type { CommandContext } from '../run';
import { DEFAULT_FORMAT, readSettings, serializeSettings, writeSettings } from '../settings/io';
import { needsWrite, planInstall, type InstallChange } from '../settings/merge';

export function describeInstallChanges(changes: readonly InstallChange[]): string {
  const lines = changes
    .filter((c) => c.kind !== 'unchanged')
    .map((c) => `  ${c.kind.padEnd(9)} ${c.event}\n`);
  const unchanged = changes.filter((c) => c.kind === 'unchanged').length;
  if (unchanged > 0) lines.push(`  unchanged ${unchanged} event(s)\n`);
  return lines.join('');
}

export function install(args: ParsedArgs, ctx: CommandContext): number {
  const { settingsPath, stdout, stderr } = ctx;
  const read = readSettings(settingsPath);
  if (read.kind === 'malformed') {
    stderr.write(
      `awaiting: ${settingsPath} is malformed (${read.error}).\n` +
        `Nothing was written. Fix the file by hand, then run install again.\n`,
    );
    return 1;
  }

  const dataDir = dataDirFor(ctx.env, ctx.homedir);
  let hookPath: string;
  let source: string | null = null;
  if (args.hookPath !== null) {
    hookPath = path.resolve(args.hookPath);
    let isFile = false;
    try {
      isFile = fs.statSync(hookPath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      stderr.write(`awaiting: --hook-path ${hookPath} is not a file. Nothing was written.\n`);
      return 1;
    }
  } else {
    source = findHookSource(hookSourceCandidates(ctx.env, ctx.cliDir));
    if (source === null) {
      stderr.write(
        'awaiting: hook script awaiting-hook.js not found. Set AWAITING_HOOK_SOURCE or pass ' +
          '--hook-path <path>. Nothing was written.\n',
      );
      return 1;
    }
    hookPath = installedHookPath(dataDir);
  }

  const base = read.kind === 'ok' ? read.value : {};
  const { value, changes } = planInstall(base, {
    hookPath,
    form: args.shellForm ? 'shell' : 'exec',
  });
  const write = needsWrite(changes);

  stdout.write(`Settings: ${settingsPath}${read.kind === 'missing' ? ' (will be created)' : ''}\n`);
  stdout.write(`Hook:     ${hookPath}${source !== null ? ` (copied from ${source})` : ''}\n`);
  stdout.write(describeInstallChanges(changes));

  if (args.dryRun) {
    stdout.write('Dry run: nothing was written.\n');
    return 0;
  }

  if (source !== null) {
    const copied = copyHook(source, dataDir);
    for (const f of copied.written) stdout.write(`Wrote ${f}\n`);
  }

  if (!write) {
    stdout.write('settings.json already up to date; nothing written.\n');
    return 0;
  }
  const format = read.kind === 'ok' ? read : DEFAULT_FORMAT;
  const { backup } = writeSettings(
    settingsPath,
    serializeSettings(value, format),
    read.kind === 'ok' ? read : null,
    ctx.now(),
  );
  if (backup !== null) stdout.write(`Backup:   ${backup}\n`);
  stdout.write(`Updated ${settingsPath}\n`);
  return 0;
}
