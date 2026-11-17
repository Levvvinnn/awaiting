// Per-session turn state machine (plan 01 §3.7 transition table, D1.19). Pure: time comes from events / `nowMs`.
import { isActionableNotificationType, isToolEventName } from '../events/names.js';
import type { NormalizedEvent } from '../events/types.js';
import {
  MAX_INFLIGHT_TOOLS,
  MAX_KNOWN_SUBAGENTS,
  REOPENABLE_END_REASONS,
  type ClosedTurnStatus,
  type EndReason,
  type SessionTurnState,
  type TurnConfig,
  type TurnEffect,
  type TurnRef,
  type TurnStepResult,
} from './types.js';

const REOPENABLE: ReadonlySet<string> = new Set(REOPENABLE_END_REASONS);

/** Applies one event to a session's turn state (`null` = first event of the session) and returns effects plus the attach seq. */
export function stepTurn(
  state: SessionTurnState | null,
  ev: NormalizedEvent,
  cfg: TurnConfig,
): TurnStepResult {
  void cfg; // Inactivity is handled by `sweepInactive`; the config is accepted for API symmetry.
  let s: SessionTurnState = state ?? {
    sessionId: ev.sessionId,
    lastSeq: 0,
    current: null,
    ended: false,
    knownSubagents: [],
  };
  // Subagent membership is decided before this event registers anything (a SubagentStart is not itself a subagent event).
  const subagent = ev.agentId !== null && s.knownSubagents.includes(ev.agentId);
  if (ev.eventName === 'SubagentStart' && ev.agentId !== null) {
    s = { ...s, knownSubagents: addCapped(s.knownSubagents, ev.agentId, MAX_KNOWN_SUBAGENTS) };
  }
  if (ev.eventName === 'SessionStart' && ev.source === 'resume') s = { ...s, ended: false };

  const t = ev.receivedAt;
  const cur = s.current;
  const open = cur !== null && cur.status === 'running' ? cur : null;

  switch (ev.eventName) {
    case 'UserPromptSubmit': {
      const effects: TurnEffect[] = [];
      if (open !== null) {
        effects.push(closeEffect(open, open.lastEventAt, 'interrupted', 'next_prompt'));
      }
      const seq = s.lastSeq + 1;
      const turn: TurnRef = {
        seq,
        promptId: ev.promptId,
        startedAt: t,
        lastEventAt: t,
        endedAt: null,
        status: 'running',
        endReason: null,
        inflightTools: [],
        awaitingUser: false,
      };
      effects.push({ type: 'open', seq, startedAt: t, promptId: ev.promptId });
      return { state: { ...s, lastSeq: seq, current: turn }, effects, attachSeq: seq };
    }

    case 'Stop':
    case 'StopFailure': {
      const [status, reason]: [ClosedTurnStatus, EndReason] =
        ev.eventName === 'Stop' ? ['done', 'stop'] : ['error', 'stop_failure'];
      if (open !== null) return touchThenClose(s, open, t, status, reason, []);
      if (cur !== null && canReopen(s, cur, t)) {
        return touchThenClose(s, reopened(cur), t, status, reason, [
          { type: 'reopen', seq: cur.seq },
        ]);
      }
      return orphan(s, ev);
    }

    case 'SessionEnd': {
      const ended = { ...s, ended: true };
      if (open === null) return orphan(ended, ev);
      const closed = closeTurn(open, open.lastEventAt, 'interrupted', 'session_end');
      return {
        state: { ...ended, current: closed },
        effects: [
          closeEffect(open, closed.endedAt ?? open.lastEventAt, 'interrupted', 'session_end'),
        ],
        attachSeq: open.seq,
      };
    }

    case 'Notification': {
      if (open === null) return orphan(s, ev);
      const awaiting = isActionableNotificationType(ev.notificationType) || open.awaitingUser;
      return touch(s, { ...open, awaitingUser: awaiting }, t);
    }

    default:
      break;
  }

  if (isToolEventName(ev.eventName) && !subagent) {
    if (open !== null) {
      const active = applyMainActivity(open, ev);
      if (ev.eventName === 'PostToolUseFailure' && ev.isInterrupt === true) {
        return touchThenClose(s, active, t, 'interrupted', 'tool_interrupt', []);
      }
      return touch(s, active, t);
    }
    // Esc on parallel tools: every interrupted tool reports its own failure. Only the first closes
    // the turn; the rest belong to it and must not reopen it (and never move `endedAt`).
    if (
      cur !== null &&
      cur.endReason === 'tool_interrupt' &&
      ev.eventName === 'PostToolUseFailure' &&
      ev.isInterrupt === true
    ) {
      return { state: s, effects: [], attachSeq: cur.seq };
    }
    if (
      cur !== null &&
      canReopen(s, cur, t) &&
      (ev.promptId === null || ev.promptId === cur.promptId)
    ) {
      const result = touch(s, applyMainActivity(reopened(cur), ev), t);
      return { ...result, effects: [{ type: 'reopen', seq: cur.seq }, ...result.effects] };
    }
    return orphan(s, ev);
  }

  // SessionStart, SubagentStart/Stop, Task*, subagent tool events.
  if (open !== null) return touch(s, open, t);
  return orphan(s, ev);
}

/** Closes the open turn as `interrupted/inactivity` at `lastEventAt` if it has been silent too long at `nowMs`. */
export function sweepInactive(
  state: SessionTurnState,
  nowMs: number,
  cfg: TurnConfig,
): TurnStepResult {
  const open = state.current?.status === 'running' ? state.current : null;
  if (open === null) return { state, effects: [], attachSeq: null };
  const limit =
    open.inflightTools.length > 0 || open.awaitingUser ? cfg.longInactivityMs : cfg.inactivityMs;
  if (nowMs - open.lastEventAt < limit) return { state, effects: [], attachSeq: null };
  const closed = closeTurn(open, open.lastEventAt, 'interrupted', 'inactivity');
  return {
    state: { ...state, current: closed },
    effects: [closeEffect(open, closed.endedAt ?? open.lastEventAt, 'interrupted', 'inactivity')],
    attachSeq: null,
  };
}

/** A closed turn may reopen if its reason allows it, the session has not ended, and the event is after the close. */
function canReopen(s: SessionTurnState, cur: TurnRef, t: number): boolean {
  return (
    !s.ended &&
    cur.status !== 'running' &&
    cur.endReason !== null &&
    REOPENABLE.has(cur.endReason) &&
    cur.endedAt !== null &&
    t > cur.endedAt
  );
}

function reopened(turn: TurnRef): TurnRef {
  return { ...turn, status: 'running', endedAt: null, endReason: null };
}

/** In-flight and awaiting-user bookkeeping for a non-subagent tool event. */
function applyMainActivity(turn: TurnRef, ev: NormalizedEvent): TurnRef {
  let inflight = turn.inflightTools;
  if (ev.toolUseId !== null) {
    if (ev.eventName === 'PreToolUse') {
      inflight = addCapped(inflight, ev.toolUseId, MAX_INFLIGHT_TOOLS);
    } else if (ev.eventName === 'PostToolUse' || ev.eventName === 'PostToolUseFailure') {
      inflight = inflight.filter((id) => id !== ev.toolUseId);
    }
  }
  return { ...turn, inflightTools: inflight, awaitingUser: ev.eventName === 'PermissionRequest' };
}

function touch(s: SessionTurnState, turn: TurnRef, t: number): TurnStepResult {
  const lastEventAt = Math.max(turn.lastEventAt, t);
  return {
    state: { ...s, current: { ...turn, lastEventAt } },
    effects: [{ type: 'touch', seq: turn.seq, lastEventAt }],
    attachSeq: turn.seq,
  };
}

/** Touches the (running) turn at `t`, then closes it at `t` (clamped to not precede its start). */
function touchThenClose(
  s: SessionTurnState,
  turn: TurnRef,
  t: number,
  status: ClosedTurnStatus,
  reason: EndReason,
  prefix: TurnEffect[],
): TurnStepResult {
  const touched = touch(s, turn, t);
  const running = touched.state.current ?? turn;
  const closed = closeTurn(running, t, status, reason);
  return {
    state: { ...touched.state, current: closed },
    effects: [
      ...prefix,
      ...touched.effects,
      closeEffect(running, closed.endedAt ?? t, status, reason),
    ],
    attachSeq: turn.seq,
  };
}

function closeTurn(
  turn: TurnRef,
  at: number,
  status: ClosedTurnStatus,
  reason: EndReason,
): TurnRef {
  return {
    ...turn,
    endedAt: Math.max(at, turn.startedAt),
    status,
    endReason: reason,
    inflightTools: [],
    awaitingUser: false,
  };
}

function closeEffect(
  turn: TurnRef,
  at: number,
  status: ClosedTurnStatus,
  reason: EndReason,
): TurnEffect {
  return { type: 'close', seq: turn.seq, endedAt: Math.max(at, turn.startedAt), status, reason };
}

/** No state change beyond what the caller already applied; the attach rule decides `attachSeq`. */
function orphan(s: SessionTurnState, ev: NormalizedEvent): TurnStepResult {
  return { state: s, effects: [], attachSeq: attachFor(s.current, ev) };
}

/** Attach rule (§3.7): same promptId → current; else the open turn; else a late event (≤ endedAt) → current; else none. */
function attachFor(cur: TurnRef | null, ev: NormalizedEvent): number | null {
  if (cur === null) return null;
  if (ev.promptId !== null && ev.promptId === cur.promptId) return cur.seq;
  if (cur.status === 'running') return cur.seq;
  if (cur.endedAt !== null && ev.receivedAt <= cur.endedAt) return cur.seq;
  return null;
}

/** Appends `item` if absent, dropping the oldest entries beyond `cap`. */
function addCapped(list: readonly string[], item: string, cap: number): readonly string[] {
  if (list.includes(item)) return list;
  const next = [...list, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
