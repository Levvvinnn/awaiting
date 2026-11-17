import { describe, expect, it } from 'vitest';
import {
  ACTIONABLE_NOTIFICATION_TYPES,
  HOOK_EVENT_NAMES,
  TOOL_EVENT_NAMES,
  isActionableNotificationType,
  isHookEventName,
  isToolEventName,
} from './names.js';
import { EVENT_DATA_KEYS, PARSE_ERROR_CODES } from './types.js';

describe('HOOK_EVENT_NAMES', () => {
  it('lists the 14 SPEC events in table order', () => {
    expect(HOOK_EVENT_NAMES).toEqual([
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
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(HOOK_EVENT_NAMES).size).toBe(HOOK_EVENT_NAMES.length);
  });

  it('TOOL_EVENT_NAMES is the four tool events, all subscribed', () => {
    expect(TOOL_EVENT_NAMES).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
    ]);
    for (const name of TOOL_EVENT_NAMES) expect(HOOK_EVENT_NAMES).toContain(name);
  });
});

describe('isHookEventName', () => {
  it.each(HOOK_EVENT_NAMES)('accepts %s', (name) => {
    expect(isHookEventName(name)).toBe(true);
  });

  it.each([
    'sessionstart',
    'SESSIONSTART',
    ' SessionStart',
    'SessionStart ',
    '',
    'PostToolBatch',
    'PermissionDenied',
    'AwaitingDoctorPing',
    'toString',
    '__proto__',
  ])('rejects %j', (name) => {
    expect(isHookEventName(name)).toBe(false);
  });

  it.each([undefined, null, 1, true, {}, [], ['Stop']])('rejects non-string %j', (value) => {
    expect(isHookEventName(value)).toBe(false);
  });
});

describe('isToolEventName', () => {
  it('accepts exactly the tool events among the subscribed events', () => {
    const accepted = HOOK_EVENT_NAMES.filter((name) => isToolEventName(name));
    expect(accepted).toEqual([...TOOL_EVENT_NAMES]);
  });

  it.each([undefined, null, 'pretooluse', 'Stop', 3])('rejects %j', (value) => {
    expect(isToolEventName(value)).toBe(false);
  });
});

describe('ACTIONABLE_NOTIFICATION_TYPES / isActionableNotificationType', () => {
  it('lists the five SPEC types', () => {
    expect(ACTIONABLE_NOTIFICATION_TYPES).toEqual([
      'permission_prompt',
      'idle_prompt',
      'elicitation_dialog',
      'elicitation_url_dialog',
      'agent_needs_input',
    ]);
  });

  it.each(ACTIONABLE_NOTIFICATION_TYPES)('accepts %s', (type) => {
    expect(isActionableNotificationType(type)).toBe(true);
  });

  it.each(['auth_success', 'Permission_Prompt', 'idle_prompt ', '', undefined, null, 0])(
    'rejects %j',
    (value) => {
      expect(isActionableNotificationType(value)).toBe(false);
    },
  );
});

describe('event contract tables', () => {
  it('EVENT_DATA_KEYS covers every subscribed event and nothing else', () => {
    expect(Object.keys(EVENT_DATA_KEYS)).toEqual([...HOOK_EVENT_NAMES]);
  });

  it('EVENT_DATA_KEYS never allowlists a raw-text field', () => {
    const banned = [
      'prompt',
      'last_assistant_message',
      'task_subject',
      'task_description',
      'tool_input',
      'tool_response',
      'transcript_path',
      'agent_transcript_path',
    ];
    for (const keys of Object.values(EVENT_DATA_KEYS)) {
      for (const key of banned) expect(keys).not.toContain(key);
    }
  });

  it('PARSE_ERROR_CODES has no duplicates', () => {
    expect(new Set(PARSE_ERROR_CODES).size).toBe(PARSE_ERROR_CODES.length);
  });
});
