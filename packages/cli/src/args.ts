// Command-line parsing (plan 01 §3.10 Flags). No dependencies.
import { isCommand, type Command } from './commands';

export type ParsedArgs = {
  command: Command | null;
  help: boolean;
  settings: string | null;
  hookPath: string | null;
  shellForm: boolean;
  dryRun: boolean;
  purge: boolean;
};

export type ArgsResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

const VALUE_FLAGS = new Set(['--settings', '--hook-path']);
const BOOLEAN_FLAGS = new Set(['--shell-form', '--dry-run', '--purge', '--help', '-h']);

/** Which flags each command accepts (besides --help). */
const ALLOWED: Record<Command, ReadonlySet<string>> = {
  install: new Set(['--settings', '--hook-path', '--shell-form', '--dry-run']),
  uninstall: new Set(['--settings', '--dry-run', '--purge']),
  doctor: new Set(['--settings']),
};

export const USAGE = `Usage: awaiting <command> [options]

Commands:
  install     Add awaiting's hook entries to Claude Code settings.json
  uninstall   Remove only awaiting's hook entries
  doctor      Check the install, the hook script, the app server and Node (read-only)

Options:
  --settings <path>   settings.json to use (default: ~/.claude/settings.json)
  --hook-path <path>  install: reference this hook script as-is instead of copying it
  --shell-form        install: write a shell-form command instead of exec form (command + args)
  --dry-run           install/uninstall: print the planned change and write nothing
  --purge             uninstall: also delete the copied hook in <dataDir>/hook/
  -h, --help          show this help

Exit codes: 0 ok, 1 failure or problem found, 2 usage error.
`;

export function parseArgs(argv: readonly string[]): ArgsResult {
  const args: ParsedArgs = {
    command: null,
    help: false,
    settings: null,
    hookPath: null,
    shellForm: false,
    dryRun: false,
    purge: false,
  };
  const seen: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    let flag = token;
    let inline: string | null = null;
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 2) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') return { ok: false, error: `${flag} needs a value` };
      if (flag === '--settings') args.settings = value;
      else args.hookPath = value;
      seen.push(flag);
    } else if (BOOLEAN_FLAGS.has(flag) && inline === null) {
      if (flag === '--help' || flag === '-h') args.help = true;
      else if (flag === '--shell-form') args.shellForm = true;
      else if (flag === '--dry-run') args.dryRun = true;
      else args.purge = true;
      seen.push(flag);
    } else if (token.startsWith('-')) {
      return { ok: false, error: `unknown option ${token}` };
    } else if (args.command === null) {
      if (!isCommand(token)) return { ok: false, error: `unknown command ${token}` };
      args.command = token;
    } else {
      return { ok: false, error: `unexpected argument ${token}` };
    }
  }
  if (args.help) return { ok: true, args };
  if (args.command === null) return { ok: false, error: 'missing command' };
  const allowed = ALLOWED[args.command];
  for (const flag of seen) {
    if (!allowed.has(flag)) return { ok: false, error: `${flag} is not valid for ${args.command}` };
  }
  return { ok: true, args };
}
