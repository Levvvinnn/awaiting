import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TURN_CONFIG,
  END_REASONS,
  MAX_INFLIGHT_TOOLS,
  MAX_KNOWN_SUBAGENTS,
  REOPENABLE_END_REASONS,
  TURN_STATUSES,
} from './types.js';

describe('turn contract constants', () => {
  it('TURN_STATUSES matches the turns.status CHECK constraint', () => {
    expect(TURN_STATUSES).toEqual(['running', 'done', 'error', 'interrupted']);
  });

  it('END_REASONS lists the six plan 01 reasons', () => {
    expect(END_REASONS).toEqual([
      'stop',
      'stop_failure',
      'next_prompt',
      'session_end',
      'inactivity',
      'tool_interrupt',
    ]);
  });

  it('only next_prompt and session_end are terminal (not reopenable)', () => {
    expect(REOPENABLE_END_REASONS).toEqual([
      'stop',
      'stop_failure',
      'inactivity',
      'tool_interrupt',
    ]);
    const terminal = END_REASONS.filter(
      (r) => !(REOPENABLE_END_REASONS as readonly string[]).includes(r),
    );
    expect(terminal).toEqual(['next_prompt', 'session_end']);
  });

  it('DEFAULT_TURN_CONFIG is 10 min / 60 min and frozen', () => {
    expect(DEFAULT_TURN_CONFIG).toEqual({ inactivityMs: 600_000, longInactivityMs: 3_600_000 });
    expect(DEFAULT_TURN_CONFIG.inactivityMs).toBeLessThan(DEFAULT_TURN_CONFIG.longInactivityMs);
    expect(Object.isFrozen(DEFAULT_TURN_CONFIG)).toBe(true);
  });

  it('caps match plan 01 §3.7', () => {
    expect(MAX_INFLIGHT_TOOLS).toBe(64);
    expect(MAX_KNOWN_SUBAGENTS).toBe(256);
  });
});
