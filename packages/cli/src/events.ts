// The handlers `awaiting install` writes into settings.json (plan 01 §3.4, D1.2, D1.3).
//
// Verified against https://code.claude.com/docs/en/hooks (read 2026-11-17):
// - #configuration: hooks.<Event>[] holds matcher groups, each with a `hooks[]` array of handlers.
// - #matcher-patterns: an omitted `matcher` matches every occurrence of the event.
// - #common-fields: `type` (required, "command"), `timeout` (seconds; not enforced for `async: true`).
// - #command-hook-fields: `command` (required), `args` (exec form, no shell), `async` (background).
// - #exec-form-and-shell-form: on Windows use `node` + script path (node.exe is a real binary).
// - #run-hooks-in-the-background: async hooks are killed at `-p` teardown, so the turn-boundary
//   events stay sync.
// - #sessionend: 1.5 s default budget; a per-hook `timeout` raises it, so SessionEnd uses 1 s.
import { HOOK_EVENT_NAMES, type HookEventName } from '@awaiting/core';

export { HOOK_EVENT_NAMES, type HookEventName };

/** Basename that identifies our handlers (D1.8). */
export const HOOK_SCRIPT_BASENAME = 'awaiting-hook.js';

/** Must equal `const HOOK_VERSION = <n>;` in hooks/awaiting-hook.js. */
export const CLI_HOOK_VERSION = 1;

/** Minimum Node major the hook supports (D1.13). */
export const MIN_NODE_MAJOR = 20;

/** Supported Claude Code floor (D1.1). Reported by doctor, never checked. */
export const MIN_CLAUDE_CODE = '2.1.290';

/** `timeout` (seconds) on the async events. Documentation only: not enforced for async hooks. */
export const ASYNC_TIMEOUT_S = 5;

/** Sync turn-boundary events and their `timeout` in seconds. */
export const SYNC_EVENT_TIMEOUTS: Readonly<Partial<Record<HookEventName, number>>> = {
  Stop: 2,
  StopFailure: 2,
  SessionEnd: 1,
};

/** Exec form (`command: "node"`, `args: [path]`) or shell form (`--shell-form`). */
export type HookForm = 'exec' | 'shell';

/** A command hook handler as we write it. */
export type CommandHandler = {
  type: 'command';
  command: string;
  args?: string[];
  async?: true;
  timeout: number;
};

/** Shell-form command string for `hookPath` (forward slashes, double-quoted). */
export function shellCommand(hookPath: string): string {
  return `node "${hookPath.replace(/\\/g, '/')}"`;
}

/** The handler `install` writes for `event`. Key order matches plan §3.4. */
export function desiredHandler(
  event: HookEventName,
  hookPath: string,
  form: HookForm,
): CommandHandler {
  const syncTimeout = SYNC_EVENT_TIMEOUTS[event];
  const base =
    form === 'exec'
      ? { type: 'command' as const, command: 'node', args: [hookPath] }
      : { type: 'command' as const, command: shellCommand(hookPath) };
  return syncTimeout === undefined
    ? { ...base, async: true, timeout: ASYNC_TIMEOUT_S }
    : { ...base, timeout: syncTimeout };
}

/** Our matcher group for `event`: no `matcher` key (match all), only our handler. */
export function desiredGroup(
  event: HookEventName,
  hookPath: string,
  form: HookForm,
): { hooks: CommandHandler[] } {
  return { hooks: [desiredHandler(event, hookPath, form)] };
}
