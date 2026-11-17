// Hook payload fixtures for tests (entry `@awaiting/core/fixtures`; never imported by production code).
//
// MODELLED ON THE DOC EXAMPLES at https://code.claude.com/docs/en/hooks (per-event "… input"
// sections, read 2026-11-16, see plan 01 §5), each with an added `received_at` (epoch ms, as the
// hook adds it). They were written without live access to the page, from the plan 01 §5 field lists
// and SPEC §Reference, so they are not byte-for-byte copies. Shapes not confirmed by those lists are
// marked as inferred below; re-check against the docs (or the M1 recording) before relying on them.
//
// Inferred shapes: Stop `background_tasks` entries (`{ id, type, description }`) and `session_crons`
// (empty array); TaskCreated/TaskCompleted `task_description`, `teammate_name`, `team_name`;
// the multi-line `error` text of the npm-test failure; the interrupt `error` text.
// `effort` (common field, an object with a `level` string per "Common input fields") appears only in
// the `preToolUseEffort` variant.
import type { HookEventName } from '../events/names.js';
import notification from './hook-payloads/notification.json';
import notificationIdlePrompt from './hook-payloads/notification--idle-prompt.json';
import permissionRequest from './hook-payloads/permission-request.json';
import postToolUse from './hook-payloads/post-tool-use.json';
import postToolUseFailure from './hook-payloads/post-tool-use-failure.json';
import postToolUseFailureInterrupt from './hook-payloads/post-tool-use-failure--interrupt.json';
import postToolUseFailureNpmTest from './hook-payloads/post-tool-use-failure--npm-test.json';
import preToolUse from './hook-payloads/pre-tool-use.json';
import preToolUseSubagent from './hook-payloads/pre-tool-use--subagent.json';
import preToolUseWindowsWrite from './hook-payloads/pre-tool-use--windows-write.json';
import sessionEnd from './hook-payloads/session-end.json';
import sessionStart from './hook-payloads/session-start.json';
import sessionStartResume from './hook-payloads/session-start--resume.json';
import stop from './hook-payloads/stop.json';
import stopBackgroundTasks from './hook-payloads/stop--background-tasks.json';
import stopFailure from './hook-payloads/stop-failure.json';
import stopFailureRateLimit from './hook-payloads/stop-failure--rate-limit.json';
import subagentStart from './hook-payloads/subagent-start.json';
import subagentStop from './hook-payloads/subagent-stop.json';
import subagentStopInternal from './hook-payloads/subagent-stop--internal.json';
import taskCompleted from './hook-payloads/task-completed.json';
import taskCreated from './hook-payloads/task-created.json';
import userPromptSubmit from './hook-payloads/user-prompt-submit.json';
import userPromptSubmitPasted from './hook-payloads/user-prompt-submit--pasted.json';
import userPromptSubmitSlashCommand from './hook-payloads/user-prompt-submit--slash-command.json';
import preToolUseEffort from './hook-payloads/pre-tool-use--effort.json';

/** A hook POST body as the server receives it (deep-frozen; use `cloneFixture` to mutate). */
export type HookPayloadFixture = Readonly<Record<string, unknown>> & {
  readonly hook_event_name: string;
  readonly session_id: string;
  readonly received_at: number;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fixture(body: { hook_event_name: string; session_id: string; received_at: number }) {
  return deepFreeze(body) as HookPayloadFixture;
}

/** One doc-modelled example per subscribed event (the server-side body, i.e. doc example + `received_at`). */
export const DOC_EXAMPLES: Readonly<Record<HookEventName, HookPayloadFixture>> = Object.freeze({
  SessionStart: fixture(sessionStart),
  UserPromptSubmit: fixture(userPromptSubmit),
  PreToolUse: fixture(preToolUse),
  PostToolUse: fixture(postToolUse),
  PostToolUseFailure: fixture(postToolUseFailure),
  PermissionRequest: fixture(permissionRequest),
  Notification: fixture(notification),
  SubagentStart: fixture(subagentStart),
  SubagentStop: fixture(subagentStop),
  TaskCreated: fixture(taskCreated),
  TaskCompleted: fixture(taskCompleted),
  Stop: fixture(stop),
  StopFailure: fixture(stopFailure),
  SessionEnd: fixture(sessionEnd),
});

/** Extra payload variants (plan 01 §4 list plus cases the parser and turn-machine tests need). */
export const VARIANTS = Object.freeze({
  /** SessionStart with `source: "resume"`. */
  sessionStartResume: fixture(sessionStartResume),
  /** PreToolUse `Write` with Windows paths in `cwd`, `transcript_path` and `tool_input.file_path`. */
  preToolUseWindowsWrite: fixture(preToolUseWindowsWrite),
  /** PostToolUseFailure of `npm test` with a multi-line `error` and `duration_ms`. */
  postToolUseFailureNpmTest: fixture(postToolUseFailureNpmTest),
  /** PostToolUseFailure with `is_interrupt: true` (user pressed Esc). */
  postToolUseFailureInterrupt: fixture(postToolUseFailureInterrupt),
  /** Stop with two `background_tasks` and empty `session_crons`. */
  stopBackgroundTasks: fixture(stopBackgroundTasks),
  /** StopFailure with `error: "rate_limit"`. */
  stopFailureRateLimit: fixture(stopFailureRateLimit),
  /** Notification `idle_prompt` without a `title`. */
  notificationIdlePrompt: fixture(notificationIdlePrompt),
  /** SubagentStop of an internal agent with an empty `agent_type` and no matching SubagentStart. */
  subagentStopInternal: fixture(subagentStopInternal),
  /** PreToolUse from inside the `agent-abc123` subagent (carries `agent_id` / `agent_type`). */
  preToolUseSubagent: fixture(preToolUseSubagent),
  /** UserPromptSubmit with `prompt_id`, a `<pasted_content>` marker line and a code fence. */
  userPromptSubmitPasted: fixture(userPromptSubmitPasted),
  /** UserPromptSubmit with `prompt_id` and a slash command. */
  userPromptSubmitSlashCommand: fixture(userPromptSubmitSlashCommand),
  /** PreToolUse carrying the common `effort` object (`{ level: "high" }`). */
  preToolUseEffort: fixture(preToolUseEffort),
});

/** Name of a variant in `VARIANTS`. */
export type VariantName = keyof typeof VARIANTS;

/** Every fixture (doc examples first, in `HOOK_EVENT_NAMES` order, then variants) with a stable name. */
export const ALL_FIXTURES: readonly {
  readonly name: string;
  readonly payload: HookPayloadFixture;
}[] = Object.freeze([
  ...Object.entries(DOC_EXAMPLES).map(([name, payload]) => ({ name: `doc:${name}`, payload })),
  ...Object.entries(VARIANTS).map(([name, payload]) => ({ name: `variant:${name}`, payload })),
]);

/** Returns a mutable deep copy of a fixture, optionally with top-level fields overridden. */
export function cloneFixture(
  payload: HookPayloadFixture,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>), ...overrides };
}
