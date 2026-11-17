import { describe, expect, it } from 'vitest';
import {
  ALL_FIXTURES,
  DOC_EXAMPLES,
  VARIANTS,
  cloneFixture,
  type HookPayloadFixture,
} from '../fixtures/index.js';
import { HOOK_EVENT_NAMES, type HookEventName } from './names.js';
import { parseHookEvent } from './parse.js';
import { promptFeatures } from './prompt-features.js';
import { sanitizeEventData } from './sanitize.js';
import {
  EVENT_DATA_KEYS,
  INVALID_FIELDS_KEY,
  STRING_LIMITS,
  type NormalizedEvent,
} from './types.js';

function sanitize(payload: Readonly<Record<string, unknown>>) {
  const eventName = payload['hook_event_name'] as HookEventName;
  const prompt = payload['prompt'];
  return sanitizeEventData({
    eventName,
    body: payload,
    promptFeatures:
      eventName === 'UserPromptSubmit' && typeof prompt === 'string'
        ? promptFeatures(prompt)
        : null,
  });
}

describe('sanitizeEventData: per-event allowlist on the doc examples', () => {
  it('SessionStart', () => {
    expect(sanitize(DOC_EXAMPLES.SessionStart)).toEqual({
      data: { source: 'startup', model: 'claude-sonnet-4-6' },
      invalidFields: [],
    });
  });

  it('UserPromptSubmit carries only prompt_features', () => {
    const { data } = sanitize(DOC_EXAMPLES.UserPromptSubmit);
    expect(Object.keys(data)).toEqual(['prompt_features']);
    expect(data['prompt_features']).toEqual(
      promptFeatures(DOC_EXAMPLES.UserPromptSubmit['prompt'] as string),
    );
  });

  it('PreToolUse', () => {
    expect(sanitize(DOC_EXAMPLES.PreToolUse).data).toEqual({
      tool_input_summary: {
        command_program: 'npm',
        command_length: 8,
        input_keys: ['command', 'description'],
      },
    });
  });

  it('PostToolUse drops tool_response', () => {
    expect(sanitize(DOC_EXAMPLES.PostToolUse).data).toEqual({
      tool_input_summary: {
        file_path: '/Users/alice/my-project/file.txt',
        input_keys: ['file_path', 'content'],
      },
    });
  });

  it('PostToolUseFailure keeps is_interrupt, duration_ms and only the first error line', () => {
    expect(sanitize(VARIANTS.postToolUseFailureNpmTest).data).toEqual({
      tool_input_summary: {
        command_program: 'npm',
        command_length: 8,
        input_keys: ['command', 'description'],
      },
      duration_ms: 4210,
      is_interrupt: false,
      error_first_line: 'Command exited with non-zero status code 1',
    });
  });

  it('PermissionRequest counts permission_suggestions', () => {
    expect(sanitize(DOC_EXAMPLES.PermissionRequest).data).toEqual({
      tool_input_summary: {
        command_program: 'rm',
        command_length: 'rm -rf node_modules'.length,
        input_keys: ['command', 'description'],
      },
      permission_suggestions_count: 1,
    });
  });

  it('Notification', () => {
    expect(sanitize(DOC_EXAMPLES.Notification).data).toEqual({
      notification_type: 'permission_prompt',
      title: 'Permission needed',
      message: 'Claude needs your permission to use Bash',
    });
    expect(sanitize(VARIANTS.notificationIdlePrompt).data).not.toHaveProperty('title');
  });

  it('SubagentStart / SubagentStop drop last_assistant_message and agent_transcript_path', () => {
    expect(sanitize(DOC_EXAMPLES.SubagentStart).data).toEqual({
      agent_id: 'agent-abc123',
      agent_type: 'Explore',
    });
    expect(sanitize(DOC_EXAMPLES.SubagentStop).data).toEqual({
      agent_id: 'agent-abc123',
      agent_type: 'Explore',
      stop_hook_active: false,
    });
    expect(sanitize(VARIANTS.subagentStopInternal).data).toMatchObject({ agent_type: '' });
  });

  it('TaskCreated / TaskCompleted keep only id and subject length', () => {
    for (const p of [DOC_EXAMPLES.TaskCreated, DOC_EXAMPLES.TaskCompleted]) {
      expect(sanitize(p).data).toEqual({
        task_id: 'task-001',
        task_subject_length: 'Implement user authentication'.length,
      });
    }
  });

  it('Stop drops last_assistant_message', () => {
    expect(sanitize(DOC_EXAMPLES.Stop).data).toEqual({ stop_hook_active: true });
  });

  it('Stop with background tasks keeps counts and distinct types only', () => {
    expect(sanitize(VARIANTS.stopBackgroundTasks).data).toEqual({
      stop_hook_active: false,
      background_tasks_count: 2,
      background_task_types: ['bash', 'agent'],
      session_crons_count: 0,
    });
  });

  it('StopFailure', () => {
    expect(sanitize(DOC_EXAMPLES.StopFailure).data).toEqual({
      error: 'server_error',
      error_details: '500 Internal Server Error',
    });
  });

  it('SessionEnd', () => {
    expect(sanitize(DOC_EXAMPLES.SessionEnd).data).toEqual({ reason: 'other' });
  });
});

describe('sanitizeEventData: rules', () => {
  it.each(ALL_FIXTURES.map((f) => [f.name, f.payload] as const))(
    '%s: data keys are within EVENT_DATA_KEYS',
    (_name, payload) => {
      const allowed: readonly string[] = EVENT_DATA_KEYS[payload.hook_event_name as HookEventName];
      const { data, invalidFields } = sanitize(payload);
      for (const key of Object.keys(data)) expect(allowed).toContain(key);
      expect(data).not.toHaveProperty(INVALID_FIELDS_KEY);
      expect(invalidFields).toEqual([]);
    },
  );

  it('does not mutate the body', () => {
    const body = cloneFixture(VARIANTS.stopBackgroundTasks);
    const before = JSON.stringify(body);
    sanitize(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it('reports wrong-typed optional fields (sorted, unique) and drops them', () => {
    const body = cloneFixture(DOC_EXAMPLES.PostToolUseFailure, {
      tool_input: 'not an object',
      duration_ms: -5,
      is_interrupt: 'yes',
      error: 42,
    });
    expect(sanitize(body)).toEqual({
      data: {},
      invalidFields: ['duration_ms', 'error', 'is_interrupt', 'tool_input'],
    });
  });

  it('treats null optional fields as absent, not invalid', () => {
    const body = cloneFixture(DOC_EXAMPLES.Notification, { title: null, message: null });
    expect(sanitize(body)).toEqual({
      data: { notification_type: 'permission_prompt' },
      invalidFields: [],
    });
  });

  it('reports wrong types on Stop arrays and booleans', () => {
    const body = cloneFixture(DOC_EXAMPLES.Stop, {
      stop_hook_active: 1,
      background_tasks: {},
      session_crons: 'x',
    });
    expect(sanitize(body)).toEqual({
      data: {},
      invalidFields: ['background_tasks', 'session_crons', 'stop_hook_active'],
    });
  });

  it('skips malformed background task entries but still counts them', () => {
    const body = cloneFixture(DOC_EXAMPLES.Stop, {
      background_tasks: [{ type: 'bash' }, 'junk', { type: 3 }, { type: 'bash' }],
    });
    expect(sanitize(body).data).toMatchObject({
      background_tasks_count: 4,
      background_task_types: ['bash'],
    });
  });

  it('caps notification title / message, StopFailure error / details and the error first line', () => {
    const long = 'x'.repeat(1000);
    expect(
      sanitize(cloneFixture(DOC_EXAMPLES.Notification, { title: long, message: long })).data,
    ).toMatchObject({
      title: 'x'.repeat(STRING_LIMITS.notificationTitle),
      message: 'x'.repeat(STRING_LIMITS.notificationMessage),
    });
    expect(
      sanitize(cloneFixture(DOC_EXAMPLES.StopFailure, { error: long, error_details: long })).data,
    ).toEqual({
      error: 'x'.repeat(STRING_LIMITS.stopError),
      error_details: 'x'.repeat(STRING_LIMITS.stopErrorDetails),
    });
    expect(
      sanitize(cloneFixture(DOC_EXAMPLES.PostToolUseFailure, { error: long + '\nsecond' })).data[
        'error_first_line'
      ],
    ).toBe('x'.repeat(STRING_LIMITS.errorFirstLine));
  });

  it('measures task_subject_length in code points', () => {
    const body = cloneFixture(DOC_EXAMPLES.TaskCreated, { task_subject: '😀😀' });
    expect(sanitize(body).data['task_subject_length']).toBe(2);
  });

  it('PreToolUse duration_ms is kept when present', () => {
    expect(sanitize(cloneFixture(DOC_EXAMPLES.PreToolUse, { duration_ms: 0 })).data).toHaveProperty(
      'duration_ms',
      0,
    );
  });

  it('covers every event name', () => {
    for (const name of HOOK_EVENT_NAMES) {
      expect(() => sanitize(DOC_EXAMPLES[name])).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Privacy sentinel (plan 01 §6.1, H3): plant a sentinel in every string field of every fixture.
// ---------------------------------------------------------------------------------------------

const SENTINEL = 'AWT_SENTINEL_7f3a9c';

/**
 * Fields whose value is stored by design (identity, metadata, capped short texts; plan 01 §3.6).
 * Keys are `<EventName or *>:<path>` with array indices written as `*`.
 */
const STORED_BY_DESIGN: ReadonlySet<string> = new Set([
  '*:hook_event_name',
  '*:session_id',
  '*:prompt_id',
  '*:agent_id',
  '*:agent_type',
  '*:cwd',
  '*:permission_mode',
  '*:effort',
  '*:effort.level',
  '*:tool_name',
  '*:tool_use_id',
  '*:tool_input.file_path',
  '*:tool_input.notebook_path',
  '*:tool_input.path',
  '*:tool_input.subagent_type',
  'SessionStart:source',
  'SessionStart:model',
  'SessionEnd:reason',
  'Notification:notification_type',
  'Notification:title',
  'Notification:message',
  'TaskCreated:task_id',
  'TaskCompleted:task_id',
  'StopFailure:error',
  'StopFailure:error_details',
  'Stop:background_tasks.*.type',
]);

/** Fields of which only a derived prefix is stored, so the sentinel is planted after that prefix. */
const PARTIAL: Readonly<Record<string, (orig: string) => string>> = {
  // Only the first line is kept as `error_first_line`.
  'PostToolUseFailure:error': (orig) => `${orig}\n${SENTINEL}`,
  // Only the basename of the first token is kept as `command_program`.
  '*:tool_input.command': (orig) => `${orig} ${SENTINEL}`,
};

type Leaf = { path: (string | number)[]; value: string };

function stringLeaves(value: unknown, path: (string | number)[] = []): Leaf[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, [...path, i]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, [...path, k]));
  }
  return [];
}

function policyKey(event: string, path: (string | number)[]): string[] {
  const p = path.map((s) => (typeof s === 'number' ? '*' : s)).join('.');
  return [`${event}:${p}`, `*:${p}`];
}

function setAt(obj: Record<string, unknown>, path: (string | number)[], v: string) {
  let o = obj as Record<string | number, unknown>;
  for (const seg of path.slice(0, -1)) o = o[seg] as Record<string | number, unknown>;
  o[path[path.length - 1] as string | number] = v;
}

const MODES: Readonly<Record<string, (orig: string) => string>> = {
  replace: () => SENTINEL,
  prefix: (orig) => `${SENTINEL} ${orig}`,
  append: (orig) => `${orig}\n${SENTINEL}`,
  // Mid-text as its own token. (Glued into a slash command it would form a valid command name,
  // which D1.17 keeps by design; prompt-features.test.ts covers that case explicitly.)
  infix: (orig) => `${orig.slice(0, 3)} ${SENTINEL} ${orig.slice(3)}`,
};

function columnsOf(event: NormalizedEvent): string {
  const columns: Partial<NormalizedEvent> = { ...event };
  delete columns.data;
  delete columns.promptText;
  return JSON.stringify(columns);
}

type Case = { name: string; field: string; mode: string; body: Record<string, unknown> };

function sentinelCases(payload: HookPayloadFixture, name: string): Case[] {
  const cases: Case[] = [];
  for (const leaf of stringLeaves(payload)) {
    const keys = policyKey(payload.hook_event_name, leaf.path);
    if (keys.some((k) => STORED_BY_DESIGN.has(k))) continue;
    const partial = keys.map((k) => PARTIAL[k]).find((f) => f !== undefined);
    const modes = partial !== undefined ? { partial } : MODES;
    for (const [mode, plant] of Object.entries(modes)) {
      const body = cloneFixture(payload);
      setAt(body, leaf.path, plant(leaf.value));
      cases.push({ name, field: leaf.path.join('.'), mode, body });
    }
  }
  return cases;
}

const CASES = ALL_FIXTURES.flatMap((f) => sentinelCases(f.payload, f.name));

describe('privacy sentinel: never stored outside promptText', () => {
  it('plants the sentinel in a meaningful number of fields', () => {
    // Every fixture has at least transcript_path; prompts, tool inputs, messages are covered too.
    expect(new Set(CASES.map((c) => c.name)).size).toBe(ALL_FIXTURES.length);
    const fields = new Set(CASES.map((c) => c.field));
    for (const f of [
      'prompt',
      'transcript_path',
      'tool_input.content',
      'tool_input.command',
      'tool_input.description',
      'tool_response.filePath',
      'last_assistant_message',
      'task_subject',
      'task_description',
      'agent_transcript_path',
      'permission_suggestions.0.rules.0.ruleContent',
      'background_tasks.0.description',
      'error',
    ]) {
      expect(fields).toContain(f);
    }
  });

  it.each(CASES.map((c) => [c.name, c.field, c.mode, c] as const))(
    '%s %s (%s)',
    (_name, field, _mode, c) => {
      for (const keepRawPrompt of [false, true]) {
        const res = parseHookEvent(c.body, { keepRawPrompt });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const needle = SENTINEL.toLowerCase();
        expect(JSON.stringify(res.event.data).toLowerCase()).not.toContain(needle);
        expect(columnsOf(res.event).toLowerCase()).not.toContain(needle);
        if (keepRawPrompt && field === 'prompt') {
          expect(res.event.promptText).toContain(SENTINEL);
        } else if (keepRawPrompt) {
          expect(res.event.promptText ?? '').not.toContain(SENTINEL);
        } else {
          expect(res.event.promptText).toBeNull();
        }
      }
    },
  );

  it('an unknown top-level key named after the sentinel is not stored', () => {
    for (const f of ALL_FIXTURES) {
      const body = cloneFixture(f.payload, { [SENTINEL]: SENTINEL });
      const res = parseHookEvent(body, { keepRawPrompt: true });
      expect(res.ok).toBe(true);
      if (res.ok) expect(JSON.stringify(res.event)).not.toContain(SENTINEL);
    }
  });

  it('control: the probe detects a sentinel in a stored-by-design field', () => {
    const res = parseHookEvent(cloneFixture(DOC_EXAMPLES.PreToolUse, { cwd: SENTINEL }), {
      keepRawPrompt: false,
    });
    expect(res.ok && columnsOf(res.event)).toContain(SENTINEL);
    const res2 = parseHookEvent(
      cloneFixture(DOC_EXAMPLES.Notification, { message: `${SENTINEL} x` }),
      { keepRawPrompt: false },
    );
    expect(res2.ok && JSON.stringify(res2.event.data)).toContain(SENTINEL);
  });
});
