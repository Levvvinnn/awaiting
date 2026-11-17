export const COMMANDS = ['install', 'uninstall', 'doctor'] as const;

export type Command = (typeof COMMANDS)[number];

/** True when `value` is one of the CLI's subcommands. */
export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}
