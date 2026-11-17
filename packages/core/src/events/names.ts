// Hook event names awaiting subscribes to. Source: SPEC.md §Reference (table order) and
// https://code.claude.com/docs/en/hooks#hook-lifecycle (read 2026-11-16, see plan 01 §5).

/** The 14 Claude Code hook events awaiting installs, in SPEC table order (also the install order). */
export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/** One of the 14 subscribed hook event names. */
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** Events that carry a required `tool_name` (the turn machine's "main activity" when not from a subagent). */
export const TOOL_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
] as const satisfies readonly HookEventName[];

/** One of the four tool events. */
export type ToolEventName = (typeof TOOL_EVENT_NAMES)[number];

/** `Notification.notification_type` values that mean the session needs the user (SPEC §Reference). */
export const ACTIONABLE_NOTIFICATION_TYPES = [
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
] as const;

/** One of the actionable notification types. */
export type ActionableNotificationType = (typeof ACTIONABLE_NOTIFICATION_TYPES)[number];

const hookEventNameSet: ReadonlySet<string> = new Set(HOOK_EVENT_NAMES);
const toolEventNameSet: ReadonlySet<string> = new Set(TOOL_EVENT_NAMES);
const actionableSet: ReadonlySet<string> = new Set(ACTIONABLE_NOTIFICATION_TYPES);

/** True if `value` is exactly one of the 14 subscribed event names (case-sensitive). */
export function isHookEventName(value: unknown): value is HookEventName {
  return typeof value === 'string' && hookEventNameSet.has(value);
}

/** True if `value` is one of the four tool event names. */
export function isToolEventName(value: unknown): value is ToolEventName {
  return typeof value === 'string' && toolEventNameSet.has(value);
}

/** True if `value` is an actionable `notification_type` (case-sensitive). */
export function isActionableNotificationType(value: unknown): value is ActionableNotificationType {
  return typeof value === 'string' && actionableSet.has(value);
}
