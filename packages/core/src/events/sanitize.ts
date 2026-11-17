// Per-event allowlist sanitization (plan 01 §3.6 table, D1.16). Anything not built here is dropped.
import type { HookEventName } from './names.js';
import { summarizeToolInput } from './tool-input.js';
import {
  STRING_LIMITS,
  type JsonObject,
  type JsonValue,
  type SanitizeInput,
  type SanitizeResult,
  type ToolInputSummary,
} from './types.js';
import {
  capString,
  codePointLength,
  firstLine,
  isArray,
  isBoolean,
  isNonNegativeFinite,
  isPlainObject,
  isString,
  readOptional,
} from './util.js';

type Body = Readonly<Record<string, unknown>>;
type Builder = (body: Body, data: JsonObject, invalid: string[], input: SanitizeInput) => void;

/** Builds the per-event allowlisted `data` object from a validated body; nothing outside `EVENT_DATA_KEYS` survives. */
export function sanitizeEventData(input: SanitizeInput): SanitizeResult {
  const data: JsonObject = {};
  const invalid: string[] = [];
  BUILDERS[input.eventName](input.body, data, invalid, input);
  return { data, invalidFields: [...new Set(invalid)].sort() };
}

function putString(body: Body, key: string, max: number, data: JsonObject, invalid: string[]) {
  const v = readOptional(body, key, isString, invalid);
  if (v !== undefined) data[key] = capString(v, max);
}

function putBoolean(body: Body, key: string, data: JsonObject, invalid: string[]) {
  const v = readOptional(body, key, isBoolean, invalid);
  if (v !== undefined) data[key] = v;
}

function putArrayCount(
  body: Body,
  key: string,
  outKey: string,
  data: JsonObject,
  invalid: string[],
) {
  const v = readOptional(body, key, isArray, invalid);
  if (v !== undefined) data[outKey] = v.length;
}

function summaryToJson(summary: ToolInputSummary): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(summary) as [string, JsonValue | undefined][]) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const tool =
  (extra?: Builder): Builder =>
  (body, data, invalid, input) => {
    const toolInput = body['tool_input'];
    if (toolInput !== undefined && toolInput !== null) {
      if (isPlainObject(toolInput)) {
        const toolName = typeof body['tool_name'] === 'string' ? body['tool_name'] : '';
        data['tool_input_summary'] = summaryToJson(summarizeToolInput(toolName, toolInput));
      } else {
        invalid.push('tool_input');
      }
    }
    const duration = readOptional(body, 'duration_ms', isNonNegativeFinite, invalid);
    if (duration !== undefined) data['duration_ms'] = duration;
    extra?.(body, data, invalid, input);
  };

const subagent: Builder = (body, data, invalid) => {
  putString(body, 'agent_id', STRING_LIMITS.id, data, invalid);
  putString(body, 'agent_type', STRING_LIMITS.id, data, invalid);
  putBoolean(body, 'stop_hook_active', data, invalid);
};

const task: Builder = (body, data, invalid) => {
  putString(body, 'task_id', STRING_LIMITS.id, data, invalid);
  const subject = readOptional(body, 'task_subject', isString, invalid);
  if (subject !== undefined) data['task_subject_length'] = codePointLength(subject);
};

const BUILDERS: Readonly<Record<HookEventName, Builder>> = {
  SessionStart: (body, data, invalid) => {
    putString(body, 'source', STRING_LIMITS.id, data, invalid);
    putString(body, 'model', STRING_LIMITS.id, data, invalid);
    putString(body, 'agent_type', STRING_LIMITS.id, data, invalid);
  },
  UserPromptSubmit: (_body, data, _invalid, input) => {
    if (input.promptFeatures !== null) data['prompt_features'] = { ...input.promptFeatures };
  },
  PreToolUse: tool(),
  PostToolUse: tool(),
  PostToolUseFailure: tool((body, data, invalid) => {
    putBoolean(body, 'is_interrupt', data, invalid);
    const error = readOptional(body, 'error', isString, invalid);
    if (error !== undefined) {
      data['error_first_line'] = capString(firstLine(error), STRING_LIMITS.errorFirstLine);
    }
  }),
  PermissionRequest: tool((body, data, invalid) => {
    putArrayCount(body, 'permission_suggestions', 'permission_suggestions_count', data, invalid);
  }),
  Notification: (body, data, invalid) => {
    putString(body, 'notification_type', STRING_LIMITS.id, data, invalid);
    putString(body, 'title', STRING_LIMITS.notificationTitle, data, invalid);
    putString(body, 'message', STRING_LIMITS.notificationMessage, data, invalid);
  },
  SubagentStart: subagent,
  SubagentStop: subagent,
  TaskCreated: task,
  TaskCompleted: task,
  Stop: (body, data, invalid) => {
    putBoolean(body, 'stop_hook_active', data, invalid);
    const tasks = readOptional(body, 'background_tasks', isArray, invalid);
    if (tasks !== undefined) {
      data['background_tasks_count'] = tasks.length;
      const types: string[] = [];
      for (const t of tasks) {
        if (!isPlainObject(t) || typeof t['type'] !== 'string') continue;
        const type = capString(t['type'], STRING_LIMITS.id);
        if (!types.includes(type) && types.length < STRING_LIMITS.inputKeys) types.push(type);
      }
      data['background_task_types'] = types;
    }
    putArrayCount(body, 'session_crons', 'session_crons_count', data, invalid);
  },
  StopFailure: (body, data, invalid) => {
    putString(body, 'error', STRING_LIMITS.stopError, data, invalid);
    putString(body, 'error_details', STRING_LIMITS.stopErrorDetails, data, invalid);
  },
  SessionEnd: (body, data, invalid) => {
    putString(body, 'reason', STRING_LIMITS.id, data, invalid);
  },
};
