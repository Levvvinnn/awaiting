import { describe, expect, it } from 'vitest';
import {
  DOC_EXAMPLES,
  VARIANTS,
  cloneFixture,
  type HookPayloadFixture,
} from '../fixtures/index.js';
import type { HookEventName } from '../events/names.js';
import { parseHookEvent } from '../events/parse.js';
import type { NormalizedEvent } from '../events/types.js';
import { stepTurn, sweepInactive } from './machine.js';
import {
  DEFAULT_TURN_CONFIG,
  MAX_INFLIGHT_TOOLS,
  MAX_KNOWN_SUBAGENTS,
  type SessionTurnState,
  type TurnEffect,
  type TurnRef,
  type TurnStepResult,
} from './types.js';

const CFG = DEFAULT_TURN_CONFIG;
const SID = 'sess-1';
const T0 = 1_800_000_000_000;

/** A minimal NormalizedEvent; turn logic reads only columns. */
function ev(
  eventName: HookEventName,
  at: number,
  over: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    eventName,
    sessionId: SID,
    receivedAt: at,
    promptId: null,
    agentId: null,
    agentType: null,
    cwd: null,
    permissionMode: null,
    effortLevel: null,
    toolName: null,
    toolUseId: null,
    notificationType: null,
    durationMs: null,
    isInterrupt: null,
    stopHookActive: null,
    source: null,
    reason: null,
    error: null,
    prompt: null,
    promptText: null,
    data: {},
    ...over,
  };
}

const ups = (at: number, promptId: string | null = null) =>
  ev('UserPromptSubmit', at, { promptId });
const pre = (at: number, id: string, over: Partial<NormalizedEvent> = {}) =>
  ev('PreToolUse', at, { toolName: 'Bash', toolUseId: id, ...over });
const post = (at: number, id: string, over: Partial<NormalizedEvent> = {}) =>
  ev('PostToolUse', at, { toolName: 'Bash', toolUseId: id, ...over });
const fail = (at: number, id: string, isInterrupt: boolean, over: Partial<NormalizedEvent> = {}) =>
  ev('PostToolUseFailure', at, { toolName: 'Bash', toolUseId: id, isInterrupt, ...over });
const perm = (at: number) => ev('PermissionRequest', at, { toolName: 'Bash' });
const notif = (at: number, notificationType: string) =>
  ev('Notification', at, { notificationType });
const stop = (at: number) => ev('Stop', at);
const stopFailure = (at: number) => ev('StopFailure', at, { error: 'server_error' });
const sessionEnd = (at: number) => ev('SessionEnd', at, { reason: 'other' });
const subStart = (at: number, agentId: string) =>
  ev('SubagentStart', at, { agentId, agentType: 'Explore' });

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const c of Object.values(v)) deepFreeze(c);
    Object.freeze(v);
  }
  return v;
}

/** Runs events through stepTurn (freezing every intermediate state to catch mutation). */
function run(
  events: NormalizedEvent[],
  initial: SessionTurnState | null = null,
): { state: SessionTurnState; steps: TurnStepResult[] } {
  let state = initial;
  const steps: TurnStepResult[] = [];
  for (const e of events) {
    const r = stepTurn(state === null ? null : deepFreeze(state), deepFreeze(e), CFG);
    steps.push(r);
    state = r.state;
  }
  if (state === null) throw new Error('no events');
  return { state, steps };
}

const last = (steps: TurnStepResult[]) => steps[steps.length - 1] as TurnStepResult;
const cur = (s: SessionTurnState) => s.current as TurnRef;

/** State with one open turn started at T0 (and optional extra events). */
function openTurn(...more: NormalizedEvent[]) {
  return run([ups(T0, 'p1'), ...more]);
}

/** State whose latest turn was closed by `closer`. */
function closedBy(closer: NormalizedEvent, ...before: NormalizedEvent[]) {
  return run([ups(T0, 'p1'), ...before, closer]);
}

describe('initial state', () => {
  it('a null state is created for the session', () => {
    const r = stepTurn(null, ev('SessionStart', T0, { source: 'startup' }), CFG);
    expect(r).toEqual({
      state: { sessionId: SID, lastSeq: 0, current: null, ended: false, knownSubagents: [] },
      effects: [],
      attachSeq: null,
    });
  });
});

describe('§3.7 table: UserPromptSubmit', () => {
  it('no open turn → opens seq+1 at receivedAt', () => {
    const { state, steps } = run([ups(T0, 'p1')]);
    expect(last(steps).effects).toEqual([{ type: 'open', seq: 1, startedAt: T0, promptId: 'p1' }]);
    expect(last(steps).attachSeq).toBe(1);
    expect(state.lastSeq).toBe(1);
    expect(cur(state)).toEqual({
      seq: 1,
      promptId: 'p1',
      startedAt: T0,
      lastEventAt: T0,
      endedAt: null,
      status: 'running',
      endReason: null,
      inflightTools: [],
      awaitingUser: false,
    });
  });

  it('open turn → close interrupted/next_prompt at lastEventAt, then open seq+1', () => {
    const { state, steps } = run([ups(T0, 'p1'), pre(T0 + 100, 't1'), ups(T0 + 5000, 'p2')]);
    expect(last(steps).effects).toEqual([
      { type: 'close', seq: 1, endedAt: T0 + 100, status: 'interrupted', reason: 'next_prompt' },
      { type: 'open', seq: 2, startedAt: T0 + 5000, promptId: 'p2' },
    ]);
    expect(last(steps).attachSeq).toBe(2);
    expect(cur(state).seq).toBe(2);
  });

  it('after a closed turn → just opens the next seq', () => {
    const { steps } = run([ups(T0), stop(T0 + 10), ups(T0 + 20)]);
    expect(last(steps).effects).toEqual([
      { type: 'open', seq: 2, startedAt: T0 + 20, promptId: null },
    ]);
  });
});

describe('§3.7 table: Stop / StopFailure', () => {
  it('Stop with an open turn → close done/stop at receivedAt', () => {
    const { state, steps } = openTurn(pre(T0 + 1, 't1'), post(T0 + 2, 't1'), stop(T0 + 3));
    expect(last(steps).effects).toEqual([
      { type: 'touch', seq: 1, lastEventAt: T0 + 3 },
      { type: 'close', seq: 1, endedAt: T0 + 3, status: 'done', reason: 'stop' },
    ]);
    expect(last(steps).attachSeq).toBe(1);
    expect(cur(state)).toMatchObject({ status: 'done', endReason: 'stop', endedAt: T0 + 3 });
  });

  it('StopFailure with an open turn → close error/stop_failure', () => {
    const { state, steps } = openTurn(stopFailure(T0 + 3));
    expect(last(steps).effects.at(-1)).toEqual({
      type: 'close',
      seq: 1,
      endedAt: T0 + 3,
      status: 'error',
      reason: 'stop_failure',
    });
    expect(cur(state).status).toBe('error');
  });

  it.each([
    ['stop', stop(T0 + 10)],
    ['stop_failure', stopFailure(T0 + 10)],
    ['tool_interrupt', fail(T0 + 10, 't1', true)],
  ])('Stop after a %s close → reopen then close done/stop (continuation)', (_r, closer) => {
    const { state, steps } = closedBy(closer, pre(T0 + 5, 't1'));
    const r = stepTurn(state, stop(T0 + 20), CFG);
    expect(r.effects).toEqual([
      { type: 'reopen', seq: 1 },
      { type: 'touch', seq: 1, lastEventAt: T0 + 20 },
      { type: 'close', seq: 1, endedAt: T0 + 20, status: 'done', reason: 'stop' },
    ]);
    expect(r.attachSeq).toBe(1);
    expect(steps).toBeDefined();
  });

  it('StopFailure after a stop close → reopen then close error/stop_failure', () => {
    const { state } = closedBy(stop(T0 + 10));
    const r = stepTurn(state, stopFailure(T0 + 20), CFG);
    expect(r.effects.map((e) => e.type)).toEqual(['reopen', 'touch', 'close']);
    expect(r.effects.at(-1)).toMatchObject({ status: 'error', reason: 'stop_failure' });
  });

  it('Stop after an inactivity close → reopen and close', () => {
    const { state } = openTurn(pre(T0 + 5, 't1'), post(T0 + 6, 't1'));
    const swept = sweepInactive(state, T0 + 6 + CFG.inactivityMs, CFG).state;
    expect(cur(swept).endReason).toBe('inactivity');
    const r = stepTurn(swept, stop(T0 + 6 + CFG.inactivityMs + 1), CFG);
    expect(r.effects.map((e) => e.type)).toEqual(['reopen', 'touch', 'close']);
  });

  it('Stop not after endedAt → no reopen (late duplicate attaches to the closed turn)', () => {
    const { state } = closedBy(stop(T0 + 10));
    for (const at of [T0 + 10, T0 + 5]) {
      const r = stepTurn(state, stop(at), CFG);
      expect(r.effects).toEqual([]);
      expect(r.attachSeq).toBe(1);
      expect(r.state).toBe(state);
    }
  });

  it.each([
    ['next_prompt', () => run([ups(T0), ups(T0 + 10), sessionEnd(T0 + 20)])],
    ['session_end', () => closedBy(sessionEnd(T0 + 10))],
  ])('Stop after a %s close → orphan, no reopen', (_r, setup) => {
    const { state } = setup();
    const r = stepTurn(state, stop(T0 + 1000), CFG);
    expect(r.effects).toEqual([]);
    expect(r.attachSeq).toBeNull();
  });

  it('Stop before any turn → orphan', () => {
    const r = stepTurn(null, stop(T0), CFG);
    expect(r.effects).toEqual([]);
    expect(r.attachSeq).toBeNull();
    expect(r.state.current).toBeNull();
  });
});

describe('§3.7 table: SessionEnd', () => {
  it('open turn → close interrupted/session_end at lastEventAt; ended = true', () => {
    const { state, steps } = openTurn(pre(T0 + 50, 't1'), sessionEnd(T0 + 9000));
    expect(last(steps).effects).toEqual([
      { type: 'close', seq: 1, endedAt: T0 + 50, status: 'interrupted', reason: 'session_end' },
    ]);
    expect(last(steps).attachSeq).toBe(1);
    expect(state.ended).toBe(true);
    expect(cur(state)).toMatchObject({ endedAt: T0 + 50, inflightTools: [] });
  });

  it('no open turn → ended = true, no effects', () => {
    const { state, steps } = closedBy(sessionEnd(T0 + 100), stop(T0 + 50));
    expect(last(steps).effects).toEqual([]);
    expect(last(steps).attachSeq).toBeNull();
    expect(state.ended).toBe(true);
    expect(cur(state).endReason).toBe('stop');
  });

  it('first event of the session → ended = true', () => {
    expect(stepTurn(null, sessionEnd(T0), CFG).state.ended).toBe(true);
  });
});

describe('§3.7 table: PostToolUseFailure is_interrupt', () => {
  it('open turn, main agent → close interrupted/tool_interrupt at receivedAt', () => {
    const { state, steps } = openTurn(pre(T0 + 10, 't1'), fail(T0 + 20, 't1', true));
    expect(last(steps).effects).toEqual([
      { type: 'touch', seq: 1, lastEventAt: T0 + 20 },
      { type: 'close', seq: 1, endedAt: T0 + 20, status: 'interrupted', reason: 'tool_interrupt' },
    ]);
    expect(cur(state)).toMatchObject({ status: 'interrupted', inflightTools: [] });
  });

  it('no open turn → handled as main activity (reopens a reopenable turn)', () => {
    const { state } = closedBy(stop(T0 + 10));
    const r = stepTurn(state, fail(T0 + 20, 't9', true), CFG);
    expect(r.effects).toEqual([
      { type: 'reopen', seq: 1 },
      { type: 'touch', seq: 1, lastEventAt: T0 + 20 },
    ]);
    expect(cur(r.state).status).toBe('running');
  });

  it('is_interrupt false only touches', () => {
    const { state, steps } = openTurn(pre(T0 + 10, 't1'), fail(T0 + 20, 't1', false));
    expect(last(steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 20 }]);
    expect(cur(state)).toMatchObject({ status: 'running', inflightTools: [] });
  });

  it('from a subagent → only touches (no close)', () => {
    const { state, steps } = openTurn(
      subStart(T0 + 1, 'ag1'),
      fail(T0 + 20, 't1', true, { agentId: 'ag1' }),
    );
    expect(last(steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 20 }]);
    expect(cur(state).status).toBe('running');
  });
});

describe('§3.7 table: main activity', () => {
  it('open turn: PreToolUse touches and adds to in-flight; Post* removes', () => {
    const a = openTurn(pre(T0 + 1, 't1'), pre(T0 + 2, 't2'));
    expect(cur(a.state).inflightTools).toEqual(['t1', 't2']);
    expect(last(a.steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 2 }]);
    const b = run([post(T0 + 3, 't1'), fail(T0 + 4, 't2', false)], a.state);
    expect(cur(b.state).inflightTools).toEqual([]);
    expect(cur(b.state).lastEventAt).toBe(T0 + 4);
  });

  it('a duplicate PreToolUse id is not added twice; an unknown Post id is ignored', () => {
    const { state } = openTurn(pre(T0 + 1, 't1'), pre(T0 + 2, 't1'), post(T0 + 3, 'zz'));
    expect(cur(state).inflightTools).toEqual(['t1']);
  });

  it('a PreToolUse without tool_use_id touches without tracking', () => {
    const { state } = openTurn(ev('PreToolUse', T0 + 1, { toolName: 'Bash' }));
    expect(cur(state).inflightTools).toEqual([]);
    expect(cur(state).lastEventAt).toBe(T0 + 1);
  });

  it(`in-flight is capped at ${MAX_INFLIGHT_TOOLS}, dropping the oldest`, () => {
    const events = Array.from({ length: MAX_INFLIGHT_TOOLS + 5 }, (_, i) =>
      pre(T0 + i + 1, `t${i}`),
    );
    const { state } = openTurn(...events);
    expect(cur(state).inflightTools).toHaveLength(MAX_INFLIGHT_TOOLS);
    expect(cur(state).inflightTools[0]).toBe('t5');
  });

  it('PermissionRequest sets awaitingUser; the next main activity clears it', () => {
    const a = openTurn(pre(T0 + 1, 't1'), perm(T0 + 2));
    expect(cur(a.state).awaitingUser).toBe(true);
    expect(last(a.steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 2 }]);
    const b = run([post(T0 + 3, 't1')], a.state);
    expect(cur(b.state).awaitingUser).toBe(false);
  });

  it('touch never moves lastEventAt backwards (out-of-order event)', () => {
    const { state, steps } = openTurn(pre(T0 + 100, 't1'), post(T0 + 50, 't1'));
    expect(cur(state).lastEventAt).toBe(T0 + 100);
    expect(last(steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 100 }]);
  });

  describe('no open turn', () => {
    it.each([
      ['stop', stop(T0 + 10)],
      ['stop_failure', stopFailure(T0 + 10)],
      ['tool_interrupt', fail(T0 + 10, 'x', true)],
    ])('reopens after a %s close when after endedAt and promptId is null', (_r, closer) => {
      const { state } = closedBy(closer);
      const r = stepTurn(state, pre(T0 + 20, 't2'), CFG);
      expect(r.effects).toEqual([
        { type: 'reopen', seq: 1 },
        { type: 'touch', seq: 1, lastEventAt: T0 + 20 },
      ]);
      expect(r.attachSeq).toBe(1);
      expect(cur(r.state)).toMatchObject({
        status: 'running',
        endedAt: null,
        endReason: null,
        inflightTools: ['t2'],
      });
    });

    it('reopens when promptId equals the turn promptId', () => {
      const { state } = closedBy(stop(T0 + 10));
      const r = stepTurn(state, pre(T0 + 20, 't2', { promptId: 'p1' }), CFG);
      expect(r.effects[0]).toEqual({ type: 'reopen', seq: 1 });
    });

    it('a different promptId → orphan (no reopen)', () => {
      const { state } = closedBy(stop(T0 + 10));
      const r = stepTurn(state, pre(T0 + 20, 't2', { promptId: 'other' }), CFG);
      expect(r.effects).toEqual([]);
      expect(r.attachSeq).toBeNull();
    });

    it('PermissionRequest reopens and sets awaitingUser', () => {
      const { state } = closedBy(stop(T0 + 10));
      const r = stepTurn(state, perm(T0 + 20), CFG);
      expect(r.effects[0]).toEqual({ type: 'reopen', seq: 1 });
      expect(cur(r.state).awaitingUser).toBe(true);
    });

    it('not after endedAt → orphan attached to the closed turn (late event)', () => {
      const { state } = closedBy(stop(T0 + 10));
      const r = stepTurn(state, post(T0 + 8, 't1'), CFG);
      expect(r.effects).toEqual([]);
      expect(r.attachSeq).toBe(1);
    });

    it('after a next_prompt or session_end close → orphan', () => {
      const a = run([ups(T0), ups(T0 + 10), sessionEnd(T0 + 20)]);
      expect(stepTurn(a.state, pre(T0 + 30, 't'), CFG).effects).toEqual([]);
      const b = closedBy(sessionEnd(T0 + 10), pre(T0 + 5, 'x'));
      expect(stepTurn(b.state, pre(T0 + 30, 't'), CFG).effects).toEqual([]);
    });

    it('before any turn → orphan', () => {
      const r = stepTurn(null, pre(T0, 't'), CFG);
      expect(r).toMatchObject({ effects: [], attachSeq: null });
    });
  });
});

describe('§3.7 table: Notification', () => {
  it.each([
    'permission_prompt',
    'idle_prompt',
    'elicitation_dialog',
    'elicitation_url_dialog',
    'agent_needs_input',
  ])('actionable %s with an open turn → touch, awaitingUser = true', (type) => {
    const { state, steps } = openTurn(notif(T0 + 5, type));
    expect(last(steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 5 }]);
    expect(cur(state).awaitingUser).toBe(true);
  });

  it('a non-actionable type only touches', () => {
    const { state, steps } = openTurn(notif(T0 + 5, 'auth_success'));
    expect(last(steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 5 }]);
    expect(cur(state).awaitingUser).toBe(false);
  });

  it('a non-actionable type does not clear awaitingUser', () => {
    const { state } = openTurn(perm(T0 + 1), notif(T0 + 5, 'auth_success'));
    expect(cur(state).awaitingUser).toBe(true);
  });

  it('no open turn → orphan', () => {
    const { state } = closedBy(stop(T0 + 10));
    const r = stepTurn(state, notif(T0 + 60_000, 'permission_prompt'), CFG);
    expect(r.effects).toEqual([]);
    expect(r.attachSeq).toBeNull();
    expect(r.state).toBe(state);
  });
});

describe('§3.7 table: anything else', () => {
  it.each<[string, NormalizedEvent]>([
    ['SessionStart', ev('SessionStart', T0 + 5, { source: 'compact' })],
    ['SubagentStart', subStart(T0 + 5, 'ag1')],
    ['SubagentStop', ev('SubagentStop', T0 + 5, { agentId: 'ag1', agentType: 'Explore' })],
    ['TaskCreated', ev('TaskCreated', T0 + 5)],
    ['TaskCompleted', ev('TaskCompleted', T0 + 5)],
  ])('%s with an open turn → touch', (_n, e) => {
    const { steps } = openTurn(e);
    expect(last(steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 5 }]);
    expect(last(steps).attachSeq).toBe(1);
  });

  it('subagent tool events with an open turn → touch only (no in-flight, no awaitingUser)', () => {
    const { state, steps } = openTurn(
      subStart(T0 + 1, 'ag1'),
      pre(T0 + 2, 's1', { agentId: 'ag1' }),
      ev('PermissionRequest', T0 + 3, { toolName: 'Bash', agentId: 'ag1' }),
    );
    expect(last(steps).effects).toEqual([{ type: 'touch', seq: 1, lastEventAt: T0 + 3 }]);
    expect(cur(state)).toMatchObject({ inflightTools: [], awaitingUser: false });
  });

  it.each<[string, NormalizedEvent]>([
    ['SessionStart', ev('SessionStart', T0 + 50, { source: 'compact' })],
    ['SubagentStop', ev('SubagentStop', T0 + 50, { agentId: 'x', agentType: '' })],
    ['TaskCompleted', ev('TaskCompleted', T0 + 50)],
  ])('%s with no open turn → orphan', (_n, e) => {
    const { state } = closedBy(stop(T0 + 10));
    const r = stepTurn(state, e, CFG);
    expect(r.effects).toEqual([]);
    expect(r.attachSeq).toBeNull();
  });

  it('SessionStart with source=resume sets ended = false', () => {
    const { state } = closedBy(sessionEnd(T0 + 10));
    expect(state.ended).toBe(true);
    const r = stepTurn(state, ev('SessionStart', T0 + 20, { source: 'resume' }), CFG);
    expect(r.state.ended).toBe(false);
    expect(r.effects).toEqual([]);
    for (const source of ['startup', 'clear', 'compact', null]) {
      expect(stepTurn(state, ev('SessionStart', T0 + 20, { source }), CFG).state.ended).toBe(true);
    }
  });

  it('SubagentStart registers the agent id (deduplicated, capped, oldest dropped)', () => {
    const { state } = run([subStart(T0, 'a'), subStart(T0 + 1, 'a')]);
    expect(state.knownSubagents).toEqual(['a']);
    const many = Array.from({ length: MAX_KNOWN_SUBAGENTS + 3 }, (_, i) =>
      subStart(T0 + i, `ag${i}`),
    );
    const big = run(many).state;
    expect(big.knownSubagents).toHaveLength(MAX_KNOWN_SUBAGENTS);
    expect(big.knownSubagents[0]).toBe('ag3');
  });

  it('an event with an unknown agent_id counts as main activity (R8)', () => {
    const { state } = openTurn(pre(T0 + 1, 't1', { agentId: 'never-started', agentType: 'x' }));
    expect(cur(state).inflightTools).toEqual(['t1']);
  });
});

describe('attach rule', () => {
  it('same promptId → current seq even when closed and after endedAt', () => {
    const { state } = closedBy(stop(T0 + 10));
    const r = stepTurn(state, ev('TaskCompleted', T0 + 999, { promptId: 'p1' }), CFG);
    expect(r.attachSeq).toBe(1);
    expect(r.effects).toEqual([]);
  });

  it('a late event (receivedAt ≤ endedAt) attaches to the closed turn', () => {
    const { state } = closedBy(stop(T0 + 10));
    expect(stepTurn(state, ev('TaskCompleted', T0 + 10), CFG).attachSeq).toBe(1);
    expect(stepTurn(state, ev('TaskCompleted', T0 + 11), CFG).attachSeq).toBeNull();
  });
});

describe('§6.1 scenarios', () => {
  it('normal turn', () => {
    const { state, steps } = run([
      ev('SessionStart', T0 - 1000, { source: 'startup' }),
      ups(T0, 'p1'),
      pre(T0 + 100, 't1'),
      post(T0 + 900, 't1'),
      stop(T0 + 1500),
    ]);
    expect(steps.map((s) => s.attachSeq)).toEqual([null, 1, 1, 1, 1]);
    expect(cur(state)).toMatchObject({
      seq: 1,
      status: 'done',
      endReason: 'stop',
      startedAt: T0,
      endedAt: T0 + 1500,
    });
  });

  it('StopFailure turn', () => {
    const { state } = run([ups(T0), pre(T0 + 1, 't'), stopFailure(T0 + 2)]);
    expect(cur(state)).toMatchObject({ status: 'error', endReason: 'stop_failure' });
  });

  it('interrupted by next prompt ends at lastEventAt', () => {
    const { steps } = run([ups(T0), pre(T0 + 300, 't'), ups(T0 + 60_000)]);
    expect(last(steps).effects[0]).toMatchObject({
      type: 'close',
      endedAt: T0 + 300,
      status: 'interrupted',
      reason: 'next_prompt',
    });
  });

  it('interrupted by SessionEnd', () => {
    const { state } = run([ups(T0), pre(T0 + 300, 't'), sessionEnd(T0 + 99_000)]);
    expect(cur(state)).toMatchObject({
      status: 'interrupted',
      endReason: 'session_end',
      endedAt: T0 + 300,
    });
  });

  it('is_interrupt close then reopen on activity', () => {
    const { state, steps } = run([
      ups(T0),
      pre(T0 + 1, 't1'),
      fail(T0 + 2, 't1', true),
      pre(T0 + 3, 't2'),
      post(T0 + 4, 't2'),
      stop(T0 + 5),
    ]);
    expect(steps[2]?.effects.at(-1)).toMatchObject({ reason: 'tool_interrupt' });
    expect(steps[3]?.effects[0]).toEqual({ type: 'reopen', seq: 1 });
    expect(cur(state)).toMatchObject({ seq: 1, status: 'done', endReason: 'stop' });
  });

  // Regression (review of T3): Esc on parallel tools sends one interrupted failure per tool. The
  // later ones took the reopen branch and left the turn running with reopened_count + 1.
  it('regression: 3 parallel interrupted failures give one close and no reopen', () => {
    const { state, steps } = run([
      ups(T0, 'p1'),
      pre(T0 + 1, 't1'),
      pre(T0 + 2, 't2'),
      pre(T0 + 3, 't3'),
      fail(T0 + 10, 't1', true),
      fail(T0 + 11, 't2', true),
      fail(T0 + 12, 't3', true, { promptId: 'p1' }),
    ]);
    const all = steps.flatMap((s) => s.effects);
    expect(all.filter((e) => e.type === 'close')).toEqual([
      { type: 'close', seq: 1, endedAt: T0 + 10, status: 'interrupted', reason: 'tool_interrupt' },
    ]);
    expect(all.filter((e) => e.type === 'reopen')).toEqual([]);
    expect(steps.slice(-2).map((s) => s.effects)).toEqual([[], []]);
    expect(steps.slice(-3).map((s) => s.attachSeq)).toEqual([1, 1, 1]);
    expect(cur(state)).toMatchObject({
      seq: 1,
      status: 'interrupted',
      endReason: 'tool_interrupt',
      endedAt: T0 + 10,
      lastEventAt: T0 + 10,
    });
  });

  it('regression: a normal PreToolUse after a tool_interrupt close still reopens', () => {
    const { state, steps } = run([
      ups(T0),
      pre(T0 + 1, 't1'),
      pre(T0 + 2, 't2'),
      fail(T0 + 10, 't1', true),
      fail(T0 + 11, 't2', true),
      pre(T0 + 20, 't3'),
    ]);
    expect(last(steps).effects).toEqual([
      { type: 'reopen', seq: 1 },
      { type: 'touch', seq: 1, lastEventAt: T0 + 20 },
    ]);
    expect(cur(state)).toMatchObject({ status: 'running', inflightTools: ['t3'] });
  });

  it('an interrupted failure after a stop close still reopens as main activity (table row)', () => {
    const { state } = run([ups(T0), stop(T0 + 10)]);
    expect(stepTurn(state, fail(T0 + 20, 'x', true), CFG).effects[0]).toEqual({
      type: 'reopen',
      seq: 1,
    });
  });

  it('stop-hook continuation (Stop, PreToolUse, Stop) is one turn reopened once', () => {
    const { state, steps } = run([
      ups(T0, 'p1'),
      stop(T0 + 10),
      pre(T0 + 20, 't1', { promptId: 'p1' }),
      post(T0 + 30, 't1', { promptId: 'p1' }),
      stop(T0 + 40),
    ]);
    const all = steps.flatMap((s) => s.effects);
    expect(all.filter((e) => e.type === 'open')).toHaveLength(1);
    expect(all.filter((e) => e.type === 'reopen')).toEqual([{ type: 'reopen', seq: 1 }]);
    expect(state.lastSeq).toBe(1);
    expect(cur(state)).toMatchObject({ status: 'done', endedAt: T0 + 40 });
  });

  it('idle_prompt after Stop does not reopen', () => {
    const { state } = run([ups(T0), stop(T0 + 10), notif(T0 + 60_010, 'idle_prompt')]);
    expect(cur(state)).toMatchObject({ status: 'done', endedAt: T0 + 10 });
  });

  it('subagent activity after Stop does not reopen', () => {
    const { state, steps } = run([
      ups(T0),
      subStart(T0 + 1, 'ag1'),
      stop(T0 + 10),
      pre(T0 + 20, 's1', { agentId: 'ag1' }),
      post(T0 + 30, 's1', { agentId: 'ag1' }),
    ]);
    expect(last(steps).effects).toEqual([]);
    expect(cur(state).status).toBe('done');
  });

  it('an internal SubagentStop with empty agent_type and no SubagentStart is an orphan', () => {
    const { state } = run([ups(T0), stop(T0 + 10)]);
    const internal = parseFixture(VARIANTS.subagentStopInternal, { received_at: T0 + 20 });
    const r = stepTurn(state, internal, CFG);
    expect(r).toMatchObject({ effects: [], attachSeq: null });
  });

  it('late event attaches to the closed turn', () => {
    const { state } = run([ups(T0), stop(T0 + 100)]);
    const r = stepTurn(state, post(T0 + 90, 'late'), CFG);
    expect(r).toMatchObject({ effects: [], attachSeq: 1 });
  });

  it('a session can have many turns with increasing seq', () => {
    const { state, steps } = run([ups(T0), stop(T0 + 1), ups(T0 + 2), stop(T0 + 3), ups(T0 + 4)]);
    expect(steps.map((s) => s.attachSeq)).toEqual([1, 1, 2, 2, 3]);
    expect(state.lastSeq).toBe(3);
  });

  it('SessionEnd blocks reopening until a resume', () => {
    const { state } = run([ups(T0), stop(T0 + 10), sessionEnd(T0 + 20)]);
    expect(stepTurn(state, stop(T0 + 30), CFG).effects).toEqual([]);
  });
});

describe('sweepInactive', () => {
  it('no open turn → unchanged', () => {
    const { state } = closedBy(stop(T0 + 10));
    expect(sweepInactive(state, T0 + 10 * CFG.longInactivityMs, CFG)).toEqual({
      state,
      effects: [],
      attachSeq: null,
    });
    const empty = stepTurn(null, ev('SessionStart', T0), CFG).state;
    expect(sweepInactive(empty, T0 + 1e9, CFG).effects).toEqual([]);
  });

  it('10 min of silence closes interrupted/inactivity at lastEventAt', () => {
    const { state } = openTurn(pre(T0 + 5, 't1'), post(T0 + 6, 't1'));
    const at = T0 + 6;
    expect(sweepInactive(state, at + CFG.inactivityMs - 1, CFG).effects).toEqual([]);
    const r = sweepInactive(state, at + CFG.inactivityMs, CFG);
    expect(r.effects).toEqual([
      { type: 'close', seq: 1, endedAt: at, status: 'interrupted', reason: 'inactivity' },
    ]);
    expect(r.attachSeq).toBeNull();
    expect(cur(r.state)).toMatchObject({ status: 'interrupted', endReason: 'inactivity' });
  });

  it('60 min with a tool in flight', () => {
    const { state } = openTurn(pre(T0 + 5, 't1'));
    expect(sweepInactive(state, T0 + 5 + CFG.inactivityMs, CFG).effects).toEqual([]);
    expect(sweepInactive(state, T0 + 5 + CFG.longInactivityMs - 1, CFG).effects).toEqual([]);
    expect(sweepInactive(state, T0 + 5 + CFG.longInactivityMs, CFG).effects).toHaveLength(1);
  });

  it('60 min while awaiting the user', () => {
    const { state } = openTurn(notif(T0 + 5, 'permission_prompt'));
    expect(sweepInactive(state, T0 + 5 + CFG.inactivityMs, CFG).effects).toEqual([]);
    expect(sweepInactive(state, T0 + 5 + CFG.longInactivityMs, CFG).effects).toHaveLength(1);
  });

  it('honors a custom config', () => {
    const { state } = openTurn();
    const cfg = { inactivityMs: 1000, longInactivityMs: 5000 };
    expect(sweepInactive(state, T0 + 999, cfg).effects).toEqual([]);
    expect(sweepInactive(state, T0 + 1000, cfg).effects).toHaveLength(1);
  });

  it('inactivity close then reopen on activity', () => {
    const { state } = openTurn(pre(T0 + 5, 't1'), post(T0 + 6, 't1'));
    const swept = sweepInactive(state, T0 + 6 + CFG.inactivityMs, CFG).state;
    const r = stepTurn(swept, pre(T0 + 6 + CFG.inactivityMs + 100, 't2'), CFG);
    expect(r.effects[0]).toEqual({ type: 'reopen', seq: 1 });
    expect(cur(r.state).status).toBe('running');
  });

  it('does not mutate the input state', () => {
    const { state } = openTurn();
    const frozen = deepFreeze(state);
    expect(() => sweepInactive(frozen, T0 + 1e9, CFG)).not.toThrow();
    expect(cur(frozen).status).toBe('running');
  });
});

describe('properties', () => {
  /** Deterministic pseudo-random event stream (LCG; no Math.random in core). */
  function stream(seed: number, n: number): NormalizedEvent[] {
    let x = seed;
    const rnd = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const makers: ((t: number) => NormalizedEvent)[] = [
      (t) => ups(t, rnd() < 0.5 ? null : `p${Math.floor(rnd() * 3)}`),
      (t) => pre(t, `t${Math.floor(rnd() * 4)}`),
      (t) => post(t, `t${Math.floor(rnd() * 4)}`),
      (t) => fail(t, `t${Math.floor(rnd() * 4)}`, rnd() < 0.5),
      (t) => perm(t),
      (t) => notif(t, rnd() < 0.5 ? 'idle_prompt' : 'other'),
      (t) => stop(t),
      (t) => stopFailure(t),
      (t) => sessionEnd(t),
      (t) => ev('SessionStart', t, { source: rnd() < 0.5 ? 'resume' : 'startup' }),
      (t) => subStart(t, `ag${Math.floor(rnd() * 2)}`),
      (t) => pre(t, 's', { agentId: `ag${Math.floor(rnd() * 2)}` }),
    ];
    const out: NormalizedEvent[] = [];
    let t = T0;
    for (let i = 0; i < n; i++) {
      t += Math.floor(rnd() * 2000) - 200; // occasional out-of-order stamps
      out.push((makers[Math.floor(rnd() * makers.length)] as (t: number) => NormalizedEvent)(t));
    }
    return out;
  }

  it('invariants hold over random streams', () => {
    for (let seed = 1; seed <= 40; seed++) {
      let state: SessionTurnState | null = null;
      for (const e of stream(seed, 120)) {
        const before: SessionTurnState | null = state;
        const r: TurnStepResult = stepTurn(before, e, CFG);
        state = r.state;
        const c = state.current;
        if (c !== null) {
          expect(c.seq).toBe(state.lastSeq);
          expect(c.lastEventAt).toBeGreaterThanOrEqual(c.startedAt);
          if (c.status === 'running') {
            expect(c.endedAt).toBeNull();
            expect(c.endReason).toBeNull();
          } else {
            expect(c.endedAt).not.toBeNull();
            expect(c.endedAt as number).toBeGreaterThanOrEqual(c.startedAt);
            expect(c.inflightTools).toEqual([]);
          }
          expect(c.inflightTools.length).toBeLessThanOrEqual(MAX_INFLIGHT_TOOLS);
        }
        for (const eff of r.effects as TurnEffect[]) {
          expect(eff.seq).toBeGreaterThanOrEqual(1);
          expect(eff.seq).toBeLessThanOrEqual(state.lastSeq);
        }
        if (r.attachSeq !== null) expect(r.attachSeq).toBeLessThanOrEqual(state.lastSeq);
        // Determinism.
        expect(stepTurn(before, e, CFG)).toEqual(r);
      }
    }
  });
});

function parseFixture(
  payload: HookPayloadFixture,
  overrides: Record<string, unknown> = {},
): NormalizedEvent {
  const res = parseHookEvent(cloneFixture(payload, overrides), { keepRawPrompt: false });
  if (!res.ok) throw new Error(res.error);
  return res.event;
}

describe('replay of parsed doc fixtures', () => {
  it('UserPromptSubmit → PreToolUse → PostToolUse → Stop gives one done turn', () => {
    const { state, steps } = run([
      parseFixture(DOC_EXAMPLES.SessionStart),
      parseFixture(DOC_EXAMPLES.UserPromptSubmit),
      parseFixture(DOC_EXAMPLES.PreToolUse),
      parseFixture(DOC_EXAMPLES.PostToolUse),
      parseFixture(DOC_EXAMPLES.Stop),
      parseFixture(DOC_EXAMPLES.SessionEnd, { received_at: DOC_EXAMPLES.Stop.received_at + 1 }),
    ]);
    expect(steps.map((s) => s.attachSeq)).toEqual([null, 1, 1, 1, 1, null]);
    expect(cur(state)).toMatchObject({
      status: 'done',
      endReason: 'stop',
      startedAt: DOC_EXAMPLES.UserPromptSubmit.received_at,
      endedAt: DOC_EXAMPLES.Stop.received_at,
    });
    expect(state.ended).toBe(true);
  });
});
