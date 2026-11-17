// Contracts for validated, sanitized hook events (plan 01 §3.6). Types plus constant tables only.
import type { HookEventName } from './names.js';

/** Any JSON-serializable value. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object (the shape of `NormalizedEvent.data`). */
export type JsonObject = { [key: string]: JsonValue };

/** Derived features of a `UserPromptSubmit.prompt`; never contains prompt text (H3). */
export type PromptFeatures = {
  /** Length in Unicode code points. */
  length: number;
  /** Whitespace-separated token count. */
  wordCount: number;
  /** Line count (an empty prompt has 0 lines; otherwise newlines + 1). */
  lineCount: number;
  /** Lines matching `^<pasted_content id="…">$`. */
  pastedBlocks: number;
  /** Code fences (lines starting with ```) in the prompt. */
  codeFences: number;
  /** True if the prompt starts with `/`. */
  isSlashCommand: boolean;
  /** Lowercased first token without trailing punctuation, kept only if it matches `^[a-z][a-z'-]{0,23}$` or `^/[a-z0-9:_-]{1,32}$`. */
  firstWord: string | null;
};

/** Content-free summary of a tool's `tool_input` (plan 01 §3.6); absent keys did not apply. */
export type ToolInputSummary = {
  /** `tool_input.file_path`, capped at `STRING_LIMITS.path`. */
  file_path?: string;
  /** `tool_input.notebook_path`, capped at `STRING_LIMITS.path`. */
  notebook_path?: string;
  /** `tool_input.path`, capped at `STRING_LIMITS.path`. */
  path?: string;
  /** Bash/PowerShell: basename of the first command token, only if it matches `^[A-Za-z0-9._-]{1,64}$`. */
  command_program?: string;
  /** Bash/PowerShell: command length in code points. */
  command_length?: number;
  /** Bash/PowerShell: `tool_input.run_in_background` when boolean. */
  run_in_background?: boolean;
  /** Agent/Task: `tool_input.subagent_type`, capped at `STRING_LIMITS.id`. */
  subagent_type?: string;
  /** Top-level `tool_input` key names (at most `STRING_LIMITS.inputKeys`, each capped at `STRING_LIMITS.toolName`). */
  input_keys: string[];
};

/** Maximum stored lengths (code points) for normalized and sanitized strings. */
export const STRING_LIMITS = {
  /** session_id, prompt_id, agent_id, agent_type, tool_use_id, task_id, permission_mode, effort, source, reason, notification_type. */
  id: 256,
  toolName: 128,
  cwd: 1024,
  /** file_path / notebook_path / path in `ToolInputSummary`. */
  path: 1024,
  /** Maximum number of entries in `ToolInputSummary.input_keys`. */
  inputKeys: 20,
  notificationTitle: 120,
  notificationMessage: 200,
  errorFirstLine: 200,
  /** `StopFailure.error` (also the `NormalizedEvent.error` column). */
  stopError: 64,
  stopErrorDetails: 200,
} as const;

/**
 * A validated hook event: flat, JSON-safe, with the raw prompt dropped unless opted in.
 * Optional fields that were absent or had the wrong type are `null` (wrong types are listed in `data.invalid_fields`).
 */
export type NormalizedEvent = {
  eventName: HookEventName;
  /** `session_id`, non-empty, ≤ `STRING_LIMITS.id`. */
  sessionId: string;
  /** `received_at` set by the hook, epoch ms. */
  receivedAt: number;
  /** `prompt_id` (absent until the first user input). */
  promptId: string | null;
  /** `agent_id` (subagent context, or SubagentStart/Stop's subject). */
  agentId: string | null;
  /** `agent_type` (may be an empty string on internal SubagentStop). */
  agentType: string | null;
  /** `cwd`, capped at `STRING_LIMITS.cwd`. */
  cwd: string | null;
  /** `permission_mode` (not sent on every event). */
  permissionMode: string | null;
  /** The common `effort` input field: `effort.level` (documented object shape) or `effort` itself if a string; `null` otherwise. */
  effortLevel: string | null;
  /** `tool_name` on the four tool events, ≤ `STRING_LIMITS.toolName`. */
  toolName: string | null;
  /** `tool_use_id` (PreToolUse / PostToolUse / PostToolUseFailure; PermissionRequest has none). */
  toolUseId: string | null;
  /** `Notification.notification_type`. */
  notificationType: string | null;
  /** `duration_ms` on PostToolUse / PostToolUseFailure (finite, ≥ 0). */
  durationMs: number | null;
  /** `PostToolUseFailure.is_interrupt`. */
  isInterrupt: boolean | null;
  /** `stop_hook_active` on Stop / SubagentStop. */
  stopHookActive: boolean | null;
  /** `SessionStart.source` (`startup`, `resume`, `clear`, `compact`, `fork`; unknown values kept as-is). */
  source: string | null;
  /** `SessionEnd.reason`. */
  reason: string | null;
  /** `StopFailure.error` only (≤ `STRING_LIMITS.stopError`); `null` on every other event. */
  error: string | null;
  /** Features of `UserPromptSubmit.prompt`; `null` on other events. */
  prompt: PromptFeatures | null;
  /** Raw prompt text, only on UserPromptSubmit with `keepRawPrompt: true`; otherwise `null`. */
  promptText: string | null;
  /** Sanitized per-event allowlist data (see `EVENT_DATA_KEYS`), plus `invalid_fields` when non-empty. */
  data: JsonObject;
};

/** Options for `parseHookEvent`. */
export type ParseOptions = {
  /** Keep the raw `prompt` in `promptText` (the `privacy.storeRawPrompt` opt-in, default off). */
  keepRawPrompt: boolean;
};

/** Every reason `parseHookEvent` can reject a body (the server answers 400 `{ error: code }`). */
export const PARSE_ERROR_CODES = [
  /** Body is not a plain JSON object (null, array, primitive). */
  'not_an_object',
  /** `session_id` missing, not a string, empty, or longer than `STRING_LIMITS.id`. */
  'invalid_session_id',
  /** `hook_event_name` missing or not a string. */
  'invalid_hook_event_name',
  /** `hook_event_name` is a string but not one of `HOOK_EVENT_NAMES`. */
  'unknown_hook_event_name',
  /** `received_at` missing, not a number, not finite, or ≤ 0. */
  'invalid_received_at',
  /** UserPromptSubmit without a string `prompt`. */
  'missing_prompt',
  /** A tool event without a string `tool_name`. */
  'missing_tool_name',
  /** Notification without a string `notification_type`. */
  'missing_notification_type',
  /** SubagentStart / SubagentStop without a string `agent_id`. */
  'missing_agent_id',
  /** TaskCreated / TaskCompleted without a string `task_id`. */
  'missing_task_id',
  /** StopFailure without a string `error`. */
  'missing_error',
] as const;

/** A `parseHookEvent` rejection code. */
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

/** Result of `parseHookEvent`. */
export type ParseResult =
  { ok: true; event: NormalizedEvent } | { ok: false; error: ParseErrorCode };

/** Input to `sanitizeEventData`: the already-validated body plus features computed by the parser. */
export type SanitizeInput = {
  eventName: HookEventName;
  /** The raw request body (a plain object). Read-only: sanitize never mutates it. */
  body: Readonly<Record<string, unknown>>;
  /** `promptFeatures(body.prompt)` on UserPromptSubmit, otherwise `null`. */
  promptFeatures: PromptFeatures | null;
};

/** Output of `sanitizeEventData`. */
export type SanitizeResult = {
  /** Allowlisted keys only (never `invalid_fields`; the parser adds that). */
  data: JsonObject;
  /** Body field names whose value had the wrong type and were dropped. */
  invalidFields: string[];
};

/** The `data` keys each event may carry (plan 01 §3.6 allowlist); `invalid_fields` is allowed on every event. */
export const EVENT_DATA_KEYS = {
  SessionStart: ['source', 'model', 'agent_type'],
  UserPromptSubmit: ['prompt_features'],
  PreToolUse: ['tool_input_summary', 'duration_ms'],
  PostToolUse: ['tool_input_summary', 'duration_ms'],
  PostToolUseFailure: ['tool_input_summary', 'duration_ms', 'is_interrupt', 'error_first_line'],
  PermissionRequest: ['tool_input_summary', 'duration_ms', 'permission_suggestions_count'],
  Notification: ['notification_type', 'title', 'message'],
  SubagentStart: ['agent_id', 'agent_type', 'stop_hook_active'],
  SubagentStop: ['agent_id', 'agent_type', 'stop_hook_active'],
  TaskCreated: ['task_id', 'task_subject_length'],
  TaskCompleted: ['task_id', 'task_subject_length'],
  Stop: [
    'stop_hook_active',
    'background_tasks_count',
    'background_task_types',
    'session_crons_count',
  ],
  StopFailure: ['error', 'error_details'],
  SessionEnd: ['reason'],
} as const satisfies Record<HookEventName, readonly string[]>;

/** Key under which the parser lists dropped wrong-typed optional fields (sorted, deduplicated). */
export const INVALID_FIELDS_KEY = 'invalid_fields';
