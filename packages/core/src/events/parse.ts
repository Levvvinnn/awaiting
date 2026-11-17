// Hook POST body validation and normalization (plan 01 §3.6). The raw prompt is dropped here unless opted in.
import { isHookEventName, isToolEventName, type HookEventName } from './names.js';
import { promptFeatures } from './prompt-features.js';
import { sanitizeEventData } from './sanitize.js';
import {
  INVALID_FIELDS_KEY,
  STRING_LIMITS,
  type JsonObject,
  type ParseErrorCode,
  type ParseOptions,
  type ParseResult,
} from './types.js';
import {
  capString,
  codePointLength,
  isBoolean,
  isNonNegativeFinite,
  isPlainObject,
  isString,
  readOptional,
} from './util.js';

/** Per-event required string fields and the error code for a missing one. */
const REQUIRED: Partial<Record<HookEventName, readonly [string, ParseErrorCode]>> = {
  UserPromptSubmit: ['prompt', 'missing_prompt'],
  PreToolUse: ['tool_name', 'missing_tool_name'],
  PostToolUse: ['tool_name', 'missing_tool_name'],
  PostToolUseFailure: ['tool_name', 'missing_tool_name'],
  PermissionRequest: ['tool_name', 'missing_tool_name'],
  Notification: ['notification_type', 'missing_notification_type'],
  SubagentStart: ['agent_id', 'missing_agent_id'],
  SubagentStop: ['agent_id', 'missing_agent_id'],
  TaskCreated: ['task_id', 'missing_task_id'],
  TaskCompleted: ['task_id', 'missing_task_id'],
  StopFailure: ['error', 'missing_error'],
};

/** Validates a hook POST body and returns a sanitized `NormalizedEvent` or a `ParseErrorCode` (never throws once implemented). */
export function parseHookEvent(body: unknown, opts: ParseOptions): ParseResult {
  if (!isPlainObject(body)) return fail('not_an_object');

  const sessionId = body['session_id'];
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    codePointLength(sessionId) > STRING_LIMITS.id
  ) {
    return fail('invalid_session_id');
  }
  const eventName = body['hook_event_name'];
  if (typeof eventName !== 'string') return fail('invalid_hook_event_name');
  if (!isHookEventName(eventName)) return fail('unknown_hook_event_name');
  const receivedAt = body['received_at'];
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) {
    return fail('invalid_received_at');
  }
  const required = REQUIRED[eventName];
  if (required !== undefined && typeof body[required[0]] !== 'string') return fail(required[1]);

  const invalid: string[] = [];
  const str = (key: string, max: number): string | null => {
    const v = readOptional(body, key, isString, invalid);
    return v === undefined ? null : capString(v, max);
  };
  const bool = (key: string): boolean | null => readOptional(body, key, isBoolean, invalid) ?? null;
  const is = (...names: HookEventName[]) => names.includes(eventName);
  const isTool = isToolEventName(eventName);

  const rawPrompt = eventName === 'UserPromptSubmit' ? (body['prompt'] as string) : null;
  const prompt = rawPrompt === null ? null : promptFeatures(rawPrompt);

  const columns = {
    eventName,
    sessionId,
    receivedAt,
    promptId: str('prompt_id', STRING_LIMITS.id),
    agentId: str('agent_id', STRING_LIMITS.id),
    agentType: str('agent_type', STRING_LIMITS.id),
    cwd: str('cwd', STRING_LIMITS.cwd),
    permissionMode: str('permission_mode', STRING_LIMITS.id),
    effortLevel: readEffortLevel(body['effort'], invalid),
    toolName: isTool ? str('tool_name', STRING_LIMITS.toolName) : null,
    toolUseId: isTool ? str('tool_use_id', STRING_LIMITS.id) : null,
    notificationType: is('Notification') ? str('notification_type', STRING_LIMITS.id) : null,
    durationMs: isTool
      ? (readOptional(body, 'duration_ms', isNonNegativeFinite, invalid) ?? null)
      : null,
    isInterrupt: is('PostToolUseFailure') ? bool('is_interrupt') : null,
    stopHookActive: is('Stop', 'SubagentStop') ? bool('stop_hook_active') : null,
    source: is('SessionStart') ? str('source', STRING_LIMITS.id) : null,
    reason: is('SessionEnd') ? str('reason', STRING_LIMITS.id) : null,
    error: is('StopFailure') ? str('error', STRING_LIMITS.stopError) : null,
    prompt,
    promptText: opts.keepRawPrompt ? rawPrompt : null,
  };

  const sanitized = sanitizeEventData({ eventName, body, promptFeatures: prompt });
  const invalidFields = [...new Set([...invalid, ...sanitized.invalidFields])].sort();
  const data: JsonObject =
    invalidFields.length > 0
      ? { ...sanitized.data, [INVALID_FIELDS_KEY]: invalidFields }
      : sanitized.data;
  return { ok: true, event: { ...columns, data } };
}

/**
 * The common `effort` field: `effort.level` when it is an object with a string `level` (documented
 * shape, hooks docs "Common input fields"), or `effort` itself when it is a string (backward-compatible).
 * Anything else present and non-null is reported as invalid.
 */
function readEffortLevel(effort: unknown, invalid: string[]): string | null {
  if (effort === undefined || effort === null) return null;
  if (typeof effort === 'string') return capString(effort, STRING_LIMITS.id);
  if (isPlainObject(effort) && typeof effort['level'] === 'string') {
    return capString(effort['level'], STRING_LIMITS.id);
  }
  invalid.push('effort');
  return null;
}

function fail(error: ParseErrorCode): ParseResult {
  return { ok: false, error };
}
