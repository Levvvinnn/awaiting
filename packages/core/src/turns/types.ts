// Contracts for the per-session turn state machine (plan 01 §3.7). Types plus constants only.

/** Every turn status, matching the `turns.status` CHECK constraint. */
export const TURN_STATUSES = ['running', 'done', 'error', 'interrupted'] as const;

/** Lifecycle status of a turn. */
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** Status of a closed turn. */
export type ClosedTurnStatus = Exclude<TurnStatus, 'running'>;

/** Every reason a turn can close, matching the `turns.end_reason` CHECK constraint. */
export const END_REASONS = [
  'stop',
  'stop_failure',
  'next_prompt',
  'session_end',
  'inactivity',
  'tool_interrupt',
] as const;

/** Why a turn closed. */
export type EndReason = (typeof END_REASONS)[number];

/** End reasons after which a later Stop / main activity may reopen the turn (if no later prompt arrived). */
export const REOPENABLE_END_REASONS = [
  'stop',
  'stop_failure',
  'inactivity',
  'tool_interrupt',
] as const satisfies readonly EndReason[];

/** Maximum `TurnRef.inflightTools` entries kept (oldest dropped first). */
export const MAX_INFLIGHT_TOOLS = 64;

/** Maximum `SessionTurnState.knownSubagents` entries kept (oldest dropped first). */
export const MAX_KNOWN_SUBAGENTS = 256;

/** The latest turn of a session (open or closed). All times are epoch ms. */
export type TurnRef = {
  /** 1-based sequence number within the session. */
  readonly seq: number;
  /** `prompt_id` of the opening UserPromptSubmit, if any. */
  readonly promptId: string | null;
  /** `receivedAt` of the opening UserPromptSubmit. */
  readonly startedAt: number;
  /** `receivedAt` of the latest event attached as activity. */
  readonly lastEventAt: number;
  /** Close time; `null` while `status === 'running'`. */
  readonly endedAt: number | null;
  readonly status: TurnStatus;
  /** `null` while running. */
  readonly endReason: EndReason | null;
  /** `tool_use_id`s of main-agent PreToolUse events without a matching Post* yet (cap `MAX_INFLIGHT_TOOLS`). */
  readonly inflightTools: readonly string[];
  /** True after a PermissionRequest or actionable Notification, until the next main activity. */
  readonly awaitingUser: boolean;
};

/** Turn-tracking state for one session. */
export type SessionTurnState = {
  readonly sessionId: string;
  /** Highest turn seq opened so far (0 before the first turn). */
  readonly lastSeq: number;
  /** The latest turn, or `null` before the first UserPromptSubmit. */
  readonly current: TurnRef | null;
  /** True after SessionEnd (cleared by SessionStart with `source = resume`). */
  readonly ended: boolean;
  /** `agent_id`s seen on SubagentStart (cap `MAX_KNOWN_SUBAGENTS`). */
  readonly knownSubagents: readonly string[];
};

/** A store mutation produced by the machine, applied in order. */
export type TurnEffect =
  | {
      readonly type: 'open';
      readonly seq: number;
      readonly startedAt: number;
      readonly promptId: string | null;
    }
  | {
      readonly type: 'close';
      readonly seq: number;
      readonly endedAt: number;
      readonly status: ClosedTurnStatus;
      readonly reason: EndReason;
    }
  /** Clears `ended_at`/`end_reason`, sets status `running`, increments `reopened_count`. */
  | { readonly type: 'reopen'; readonly seq: number }
  | { readonly type: 'touch'; readonly seq: number; readonly lastEventAt: number };

/** Result of `stepTurn` and `sweepInactive`. */
export type TurnStepResult = {
  /** The next session state (inputs are never mutated). */
  readonly state: SessionTurnState;
  readonly effects: readonly TurnEffect[];
  /** Turn seq the event belongs to (`events.turn_id`), or `null` for an orphan; always `null` from `sweepInactive`. */
  readonly attachSeq: number | null;
};

/** Inactivity thresholds for closing silent turns as `interrupted/inactivity`. */
export type TurnConfig = {
  /** Silence after which an open turn closes (no tool in flight, not awaiting the user). */
  readonly inactivityMs: number;
  /** Silence after which an open turn closes while a tool is in flight or the user is awaited. */
  readonly longInactivityMs: number;
};

/** Defaults: 10 min, or 60 min with a tool in flight / awaiting the user (plan 01 D1.19). */
export const DEFAULT_TURN_CONFIG: TurnConfig = Object.freeze({
  inactivityMs: 600_000,
  longInactivityMs: 3_600_000,
});
