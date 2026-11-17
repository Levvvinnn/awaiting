import { describe, expect, it } from 'vitest';
import { ALL_FIXTURES, DOC_EXAMPLES, VARIANTS, cloneFixture } from '../fixtures/index.js';
import { HOOK_EVENT_NAMES, type HookEventName } from './names.js';
import { parseHookEvent } from './parse.js';
import { promptFeatures } from './prompt-features.js';
import {
  EVENT_DATA_KEYS,
  INVALID_FIELDS_KEY,
  PARSE_ERROR_CODES,
  STRING_LIMITS,
  type NormalizedEvent,
  type ParseErrorCode,
} from './types.js';

const OFF = { keepRawPrompt: false };

function parseOk(body: unknown, opts = OFF): NormalizedEvent {
  const res = parseHookEvent(body, opts);
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  return res.event;
}

function parseErr(body: unknown): ParseErrorCode {
  const res = parseHookEvent(body, OFF);
  if (res.ok) throw new Error('expected an error');
  return res.error;
}

const NORMALIZED_KEYS = [
  'eventName',
  'sessionId',
  'receivedAt',
  'promptId',
  'agentId',
  'agentType',
  'cwd',
  'permissionMode',
  'effortLevel',
  'toolName',
  'toolUseId',
  'notificationType',
  'durationMs',
  'isInterrupt',
  'stopHookActive',
  'source',
  'reason',
  'error',
  'prompt',
  'promptText',
  'data',
].sort();

describe('parseHookEvent: fixtures', () => {
  it.each(ALL_FIXTURES.map((f) => [f.name, f.payload] as const))(
    '%s parses into a flat, JSON-safe event',
    (_name, payload) => {
      const ev = parseOk(payload);
      expect(Object.keys(ev).sort()).toEqual(NORMALIZED_KEYS);
      expect(ev.eventName).toBe(payload.hook_event_name);
      expect(ev.sessionId).toBe(payload.session_id);
      expect(ev.receivedAt).toBe(payload.received_at);
      expect(JSON.parse(JSON.stringify(ev))).toEqual(ev);
      const allowed: readonly string[] = EVENT_DATA_KEYS[ev.eventName];
      for (const key of Object.keys(ev.data)) {
        expect([...allowed, INVALID_FIELDS_KEY]).toContain(key);
      }
      expect(ev.data).not.toHaveProperty(INVALID_FIELDS_KEY);
    },
  );

  it('SessionStart columns', () => {
    expect(parseOk(DOC_EXAMPLES.SessionStart)).toMatchObject({
      source: 'startup',
      cwd: '/Users/alice/my-project',
      permissionMode: null,
      promptId: null,
      toolName: null,
      reason: null,
      error: null,
      prompt: null,
      promptText: null,
    });
    expect(parseOk(VARIANTS.sessionStartResume).source).toBe('resume');
  });

  it('UserPromptSubmit has features and no text by default', () => {
    const ev = parseOk(DOC_EXAMPLES.UserPromptSubmit);
    expect(ev.prompt).toEqual(promptFeatures(DOC_EXAMPLES.UserPromptSubmit['prompt'] as string));
    expect(ev.promptText).toBeNull();
    expect(parseOk(VARIANTS.userPromptSubmitPasted).promptId).toBe('prompt-0001');
  });

  it('UserPromptSubmit keeps the raw text only with keepRawPrompt', () => {
    const ev = parseOk(DOC_EXAMPLES.UserPromptSubmit, { keepRawPrompt: true });
    expect(ev.promptText).toBe(DOC_EXAMPLES.UserPromptSubmit['prompt']);
    // Raw text never lands in data even when opted in.
    expect(JSON.stringify(ev.data)).not.toContain('factorial');
  });

  it('keepRawPrompt has no effect on other events', () => {
    for (const name of HOOK_EVENT_NAMES.filter((n) => n !== 'UserPromptSubmit')) {
      const ev = parseOk(cloneFixture(DOC_EXAMPLES[name], { prompt: 'stray' }), {
        keepRawPrompt: true,
      });
      expect(ev.promptText).toBeNull();
      expect(ev.prompt).toBeNull();
    }
  });

  it('tool events', () => {
    expect(parseOk(DOC_EXAMPLES.PreToolUse)).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'toolu_01ABC123',
      permissionMode: 'default',
      durationMs: null,
      isInterrupt: null,
      error: null,
    });
    expect(parseOk(DOC_EXAMPLES.PermissionRequest)).toMatchObject({
      toolName: 'Bash',
      toolUseId: null,
    });
    expect(parseOk(VARIANTS.postToolUseFailureNpmTest)).toMatchObject({
      durationMs: 4210,
      isInterrupt: false,
    });
    expect(parseOk(VARIANTS.postToolUseFailureInterrupt).isInterrupt).toBe(true);
    expect(parseOk(VARIANTS.preToolUseSubagent)).toMatchObject({
      agentId: 'agent-abc123',
      agentType: 'Explore',
    });
  });

  it('tolerates tool_response and never stores it', () => {
    const ev = parseOk(DOC_EXAMPLES.PostToolUse);
    expect(JSON.stringify(ev)).not.toContain('filePath');
    expect(ev.data).not.toHaveProperty('tool_response');
    // Any shape of tool_response is accepted.
    for (const tool_response of ['text', 5, null, [1, 2], { deep: { x: 1 } }]) {
      expect(
        parseHookEvent(cloneFixture(DOC_EXAMPLES.PostToolUse, { tool_response }), OFF).ok,
      ).toBe(true);
    }
  });

  it('error column is StopFailure error only; PostToolUseFailure error goes to data', () => {
    expect(parseOk(DOC_EXAMPLES.StopFailure).error).toBe('server_error');
    expect(parseOk(VARIANTS.stopFailureRateLimit).error).toBe('rate_limit');
    const failure = parseOk(VARIANTS.postToolUseFailureNpmTest);
    expect(failure.error).toBeNull();
    expect(failure.data['error_first_line']).toBe('Command exited with non-zero status code 1');
  });

  it('Notification / Subagent / Stop / SessionEnd columns', () => {
    expect(parseOk(DOC_EXAMPLES.Notification).notificationType).toBe('permission_prompt');
    expect(parseOk(DOC_EXAMPLES.SubagentStart).agentId).toBe('agent-abc123');
    expect(parseOk(VARIANTS.subagentStopInternal).agentType).toBe('');
    expect(parseOk(DOC_EXAMPLES.Stop).stopHookActive).toBe(true);
    expect(parseOk(DOC_EXAMPLES.SubagentStop).stopHookActive).toBe(false);
    expect(parseOk(DOC_EXAMPLES.SessionEnd).reason).toBe('other');
  });

  it('event-specific columns are null on other events', () => {
    const ev = parseOk(
      cloneFixture(DOC_EXAMPLES.Stop, {
        source: 'startup',
        reason: 'other',
        error: 'x',
        tool_name: 'Bash',
        notification_type: 'idle_prompt',
        is_interrupt: true,
        duration_ms: 5,
      }),
    );
    expect(ev).toMatchObject({
      source: null,
      reason: null,
      error: null,
      toolName: null,
      notificationType: null,
      isInterrupt: null,
      durationMs: null,
    });
  });

  describe('effortLevel', () => {
    it('is effort.level for the documented object shape (fixture variant)', () => {
      const ev = parseOk(VARIANTS.preToolUseEffort);
      expect(ev.effortLevel).toBe('high');
      expect(ev.data).not.toHaveProperty(INVALID_FIELDS_KEY);
    });

    it('ignores extra keys on the effort object', () => {
      const ev = parseOk(cloneFixture(DOC_EXAMPLES.Stop, { effort: { level: 'low', other: 1 } }));
      expect(ev.effortLevel).toBe('low');
      expect(JSON.stringify(ev)).not.toContain('other');
    });

    it('keeps a plain string effort (backward-compatible)', () => {
      const ev = parseOk(cloneFixture(DOC_EXAMPLES.Stop, { effort: 'high' }));
      expect(ev.effortLevel).toBe('high');
      expect(ev.data).not.toHaveProperty(INVALID_FIELDS_KEY);
    });

    it('is null without invalid_fields when effort is absent or null', () => {
      for (const effort of [undefined, null]) {
        const ev = parseOk(cloneFixture(DOC_EXAMPLES.Stop, { effort }));
        expect(ev.effortLevel).toBeNull();
        expect(ev.data).not.toHaveProperty(INVALID_FIELDS_KEY);
      }
    });

    it.each([
      ['number', 3],
      ['boolean', true],
      ['array', ['high']],
      ['object without level', {}],
      ['object with null level', { level: null }],
      ['object with numeric level', { level: 2 }],
      ['object with object level', { level: { name: 'high' } }],
    ])('is null and listed in invalid_fields for %s', (_label, effort) => {
      const ev = parseOk(cloneFixture(DOC_EXAMPLES.Stop, { effort }));
      expect(ev.effortLevel).toBeNull();
      expect(ev.data[INVALID_FIELDS_KEY]).toEqual(['effort']);
    });

    it('is capped at STRING_LIMITS.id in both shapes', () => {
      const long = 'e'.repeat(STRING_LIMITS.id + 100);
      for (const effort of [long, { level: long }]) {
        expect(parseOk(cloneFixture(DOC_EXAMPLES.Stop, { effort })).effortLevel).toHaveLength(
          STRING_LIMITS.id,
        );
      }
    });
  });

  it('works on deep-frozen input and does not mutate it', () => {
    const before = JSON.stringify(DOC_EXAMPLES.PostToolUse);
    parseOk(DOC_EXAMPLES.PostToolUse);
    expect(JSON.stringify(DOC_EXAMPLES.PostToolUse)).toBe(before);
  });

  it('accepts a null-prototype body', () => {
    const body = Object.assign(Object.create(null) as Record<string, unknown>, {
      ...cloneFixture(DOC_EXAMPLES.Stop),
    });
    expect(parseHookEvent(body, OFF).ok).toBe(true);
  });

  it('is deterministic', () => {
    for (const f of ALL_FIXTURES) {
      expect(parseHookEvent(f.payload, OFF)).toEqual(parseHookEvent(f.payload, OFF));
    }
  });
});

describe('parseHookEvent: common required fields', () => {
  const base = () => cloneFixture(DOC_EXAMPLES.Stop);

  it.each([null, undefined, [], [DOC_EXAMPLES.Stop], 'x', 1, true, new Date(0)])(
    'not_an_object: %j',
    (body) => {
      expect(parseErr(body)).toBe('not_an_object');
    },
  );

  it.each([
    ['missing', undefined],
    ['number', 5],
    ['empty', ''],
    ['too long', 'x'.repeat(STRING_LIMITS.id + 1)],
    ['null', null],
  ])('invalid_session_id: %s', (_label, session_id) => {
    expect(parseErr({ ...base(), session_id })).toBe('invalid_session_id');
  });

  it('session_id at the limit is accepted, measured in code points', () => {
    expect(parseOk({ ...base(), session_id: 'x'.repeat(STRING_LIMITS.id) }).sessionId).toHaveLength(
      STRING_LIMITS.id,
    );
    // 256 emoji = 512 UTF-16 units but 256 code points.
    expect(parseHookEvent({ ...base(), session_id: '😀'.repeat(STRING_LIMITS.id) }, OFF).ok).toBe(
      true,
    );
  });

  it.each([
    ['missing', undefined],
    ['number', 3],
    ['object', {}],
  ])('invalid_hook_event_name: %s', (_label, hook_event_name) => {
    expect(parseErr({ ...base(), hook_event_name })).toBe('invalid_hook_event_name');
  });

  it.each(['Foo', 'stop', 'PostToolBatch', 'AwaitingDoctorPing', ''])(
    'unknown_hook_event_name: %j',
    (hook_event_name) => {
      expect(parseErr({ ...base(), hook_event_name })).toBe('unknown_hook_event_name');
    },
  );

  it.each([
    ['missing', undefined],
    ['string', '1794787211000'],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -1],
    ['null', null],
  ])('invalid_received_at: %s', (_label, received_at) => {
    expect(parseErr({ ...base(), received_at })).toBe('invalid_received_at');
  });

  it('checks in order: object, session_id, hook_event_name, received_at', () => {
    expect(parseErr({ hook_event_name: 'Nope' })).toBe('invalid_session_id');
    expect(parseErr({ session_id: 's', hook_event_name: 'Nope' })).toBe('unknown_hook_event_name');
    expect(parseErr({ session_id: 's', hook_event_name: 'Stop' })).toBe('invalid_received_at');
    expect(parseErr({ session_id: 's', hook_event_name: 'StopFailure', received_at: 1 })).toBe(
      'missing_error',
    );
  });
});

describe('parseHookEvent: per-event required fields', () => {
  const cases: [HookEventName, string, ParseErrorCode][] = [
    ['UserPromptSubmit', 'prompt', 'missing_prompt'],
    ['PreToolUse', 'tool_name', 'missing_tool_name'],
    ['PostToolUse', 'tool_name', 'missing_tool_name'],
    ['PostToolUseFailure', 'tool_name', 'missing_tool_name'],
    ['PermissionRequest', 'tool_name', 'missing_tool_name'],
    ['Notification', 'notification_type', 'missing_notification_type'],
    ['SubagentStart', 'agent_id', 'missing_agent_id'],
    ['SubagentStop', 'agent_id', 'missing_agent_id'],
    ['TaskCreated', 'task_id', 'missing_task_id'],
    ['TaskCompleted', 'task_id', 'missing_task_id'],
    ['StopFailure', 'error', 'missing_error'],
  ];

  it.each(cases)('%s without a string %s → %s', (event, field, code) => {
    expect(parseErr(cloneFixture(DOC_EXAMPLES[event], { [field]: undefined }))).toBe(code);
    expect(parseErr(cloneFixture(DOC_EXAMPLES[event], { [field]: 42 }))).toBe(code);
    expect(parseErr(cloneFixture(DOC_EXAMPLES[event], { [field]: null }))).toBe(code);
  });

  it('covers every parse error code', () => {
    const covered = new Set<ParseErrorCode>([
      'not_an_object',
      'invalid_session_id',
      'invalid_hook_event_name',
      'unknown_hook_event_name',
      'invalid_received_at',
      ...cases.map((c) => c[2]),
    ]);
    expect([...covered].sort()).toEqual([...PARSE_ERROR_CODES].sort());
  });

  it('SessionStart, Stop and SessionEnd need only the common fields', () => {
    for (const hook_event_name of ['SessionStart', 'Stop', 'SessionEnd']) {
      expect(parseHookEvent({ session_id: 's', hook_event_name, received_at: 1 }, OFF).ok).toBe(
        true,
      );
    }
  });

  it('an empty prompt is a valid prompt', () => {
    expect(
      parseOk(cloneFixture(DOC_EXAMPLES.UserPromptSubmit, { prompt: '' })).prompt,
    ).toMatchObject({ length: 0 });
  });
});

describe('parseHookEvent: lenient optional fields', () => {
  it('a wrong-typed optional field becomes null and is listed in invalid_fields (sorted, unique)', () => {
    const ev = parseOk(
      cloneFixture(VARIANTS.postToolUseFailureNpmTest, {
        cwd: 5,
        prompt_id: {},
        permission_mode: false,
        tool_use_id: 7,
        duration_ms: -1,
        is_interrupt: 'yes',
      }),
    );
    expect(ev).toMatchObject({
      cwd: null,
      promptId: null,
      permissionMode: null,
      toolUseId: null,
      durationMs: null,
      isInterrupt: null,
    });
    expect(ev.data[INVALID_FIELDS_KEY]).toEqual([
      'cwd',
      'duration_ms',
      'is_interrupt',
      'permission_mode',
      'prompt_id',
      'tool_use_id',
    ]);
    expect(ev.data).not.toHaveProperty('duration_ms');
    expect(ev.data).not.toHaveProperty('is_interrupt');
  });

  it('merges sanitize invalid fields into data.invalid_fields', () => {
    const ev = parseOk(cloneFixture(DOC_EXAMPLES.Notification, { title: 1, cwd: [] }));
    expect(ev.data[INVALID_FIELDS_KEY]).toEqual(['cwd', 'title']);
  });

  it('a field rejected by both column and data readers is listed once', () => {
    const ev = parseOk(cloneFixture(DOC_EXAMPLES.SubagentStart, { agent_type: 9 }));
    expect(ev.agentType).toBeNull();
    expect(ev.data[INVALID_FIELDS_KEY]).toEqual(['agent_type']);
  });

  it('null optional fields are absent, not invalid', () => {
    const ev = parseOk(cloneFixture(DOC_EXAMPLES.PreToolUse, { cwd: null, prompt_id: null }));
    expect(ev.cwd).toBeNull();
    expect(ev.data).not.toHaveProperty(INVALID_FIELDS_KEY);
  });

  it('caps column strings', () => {
    const ev = parseOk(
      cloneFixture(DOC_EXAMPLES.PreToolUse, {
        cwd: 'c'.repeat(5000),
        tool_name: 't'.repeat(500),
        prompt_id: 'p'.repeat(500),
        agent_id: 'a'.repeat(500),
        tool_use_id: 'u'.repeat(500),
      }),
    );
    expect(ev.cwd).toHaveLength(STRING_LIMITS.cwd);
    expect(ev.toolName).toHaveLength(STRING_LIMITS.toolName);
    expect(ev.promptId).toHaveLength(STRING_LIMITS.id);
    expect(ev.agentId).toHaveLength(STRING_LIMITS.id);
    expect(ev.toolUseId).toHaveLength(STRING_LIMITS.id);
    expect(
      parseOk(cloneFixture(DOC_EXAMPLES.StopFailure, { error: 'e'.repeat(100) })).error,
    ).toHaveLength(STRING_LIMITS.stopError);
  });

  it('never throws on odd bodies (property)', () => {
    const odd: unknown[] = [0, '', [], {}, { session_id: 's' }, Object.create(null)];
    const values: unknown[] = [undefined, null, 0, -1, 'x', '', true, [], {}, [{}], { a: [1] }];
    const fields = [
      'session_id',
      'hook_event_name',
      'received_at',
      'prompt',
      'tool_name',
      'tool_input',
      'background_tasks',
      'permission_suggestions',
      'agent_id',
    ];
    for (const name of HOOK_EVENT_NAMES) {
      for (const field of fields) {
        for (const value of values) {
          odd.push(cloneFixture(DOC_EXAMPLES[name], { [field]: value }));
        }
      }
    }
    for (const body of odd) {
      expect(() => parseHookEvent(body, OFF)).not.toThrow();
      const res = parseHookEvent(body, OFF);
      if (!res.ok) expect(PARSE_ERROR_CODES).toContain(res.error);
    }
  });
});
