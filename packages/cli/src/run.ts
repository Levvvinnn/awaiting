// CLI entry logic: `run(argv, deps)` returns the exit code (0 ok, 1 failure, 2 usage).
import { USAGE, parseArgs } from './args';
import { doctor } from './commands/doctor';
import { install } from './commands/install';
import { uninstall } from './commands/uninstall';
import { isForbiddenRealSettings, settingsPathFor, type Env } from './paths';

export type Writer = { write(chunk: string): unknown };

export type Deps = {
  env: Env;
  homedir: string;
  now: () => number;
  stdout: Writer;
  stderr: Writer;
  /** Directory of the running CLI (locates the bundled or repo hook script). */
  cliDir: string;
};

export type CommandContext = Deps & { settingsPath: string };

export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr.write(`awaiting: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help || args.command === null) {
    deps.stdout.write(USAGE);
    return 0;
  }
  const settingsPath = settingsPathFor(args.settings, deps.homedir);
  if (isForbiddenRealSettings(settingsPath, deps.env)) {
    deps.stderr.write(
      `awaiting: refusing to use the real ${settingsPath} while AWAITING_FORBID_REAL_SETTINGS=1\n`,
    );
    return 2;
  }
  const ctx: CommandContext = { ...deps, settingsPath };
  try {
    switch (args.command) {
      case 'install':
        return install(args, ctx);
      case 'uninstall':
        return uninstall(args, ctx);
      case 'doctor':
        return await doctor(ctx);
    }
  } catch (err) {
    deps.stderr.write(`awaiting: ${(err as Error).message}\n`);
    return 1;
  }
}
