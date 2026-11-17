import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAMES } from '../events/names.js';
import { ALL_FIXTURES, DOC_EXAMPLES, VARIANTS, cloneFixture } from './index.js';

describe('hook payload fixtures', () => {
  it('has one doc example per subscribed event, keyed by its own hook_event_name', () => {
    expect(Object.keys(DOC_EXAMPLES)).toEqual([...HOOK_EVENT_NAMES]);
    for (const name of HOOK_EVENT_NAMES) {
      expect(DOC_EXAMPLES[name].hook_event_name).toBe(name);
    }
  });

  it.each(ALL_FIXTURES.map((f) => [f.name, f.payload] as const))(
    '%s has the hook-added fields',
    (_name, payload) => {
      expect(HOOK_EVENT_NAMES).toContain(payload.hook_event_name);
      expect(typeof payload.session_id).toBe('string');
      expect(payload.session_id.length).toBeGreaterThan(0);
      expect(Number.isInteger(payload.received_at)).toBe(true);
      expect(payload.received_at).toBeGreaterThan(0);
    },
  );

  it('ALL_FIXTURES has unique names and received_at values', () => {
    expect(ALL_FIXTURES).toHaveLength(HOOK_EVENT_NAMES.length + Object.keys(VARIANTS).length);
    expect(new Set(ALL_FIXTURES.map((f) => f.name)).size).toBe(ALL_FIXTURES.length);
    expect(new Set(ALL_FIXTURES.map((f) => f.payload.received_at)).size).toBe(ALL_FIXTURES.length);
  });

  it('covers the plan 01 §4 variants', () => {
    expect(VARIANTS.preToolUseWindowsWrite['cwd']).toBe('C:\\Users\\alice\\my-project');
    expect(VARIANTS.preToolUseWindowsWrite['tool_input']).toMatchObject({
      file_path: 'C:\\Users\\alice\\my-project\\src\\app.ts',
    });
    expect(VARIANTS.postToolUseFailureNpmTest['tool_input']).toMatchObject({ command: 'npm test' });
    expect(VARIANTS.sessionStartResume['source']).toBe('resume');
    expect(Array.isArray(VARIANTS.stopBackgroundTasks['background_tasks'])).toBe(true);
    expect(VARIANTS.stopFailureRateLimit['error']).toBe('rate_limit');
    expect(VARIANTS.postToolUseFailureInterrupt['is_interrupt']).toBe(true);
    expect(VARIANTS.subagentStopInternal['agent_type']).toBe('');
  });

  it('is deep-frozen so tests cannot leak mutations', () => {
    const p = DOC_EXAMPLES.PreToolUse;
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p['tool_input'])).toBe(true);
    expect(() => {
      (p as Record<string, unknown>)['session_id'] = 'x';
    }).toThrow(TypeError);
  });

  it('cloneFixture returns an independent mutable deep copy with overrides', () => {
    const copy = cloneFixture(DOC_EXAMPLES.PreToolUse, { session_id: 'other' });
    expect(copy['session_id']).toBe('other');
    expect(copy['tool_input']).toEqual(DOC_EXAMPLES.PreToolUse['tool_input']);
    (copy['tool_input'] as Record<string, unknown>)['command'] = 'changed';
    expect(DOC_EXAMPLES.PreToolUse['tool_input']).toMatchObject({ command: 'npm test' });
  });
});
