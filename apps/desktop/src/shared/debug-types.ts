// Debug view data contract between main, preload and renderer (plan 01 §3.9).
// Measured times only: no estimates of any kind (H5). The validators run in the preload on every
// payload from main and reject missing, extra or wrong-typed fields.
import {
  END_REASONS,
  HOOK_EVENT_NAMES,
  TURN_STATUSES,
  type EndReason,
  type HookEventName,
  type TurnStatus,
} from '@awaiting/core';

/** One stored hook event as shown in the debug list. Times are epoch ms. */
export interface DebugEventRow {
  readonly id: number;
  readonly receivedAt: number;
  readonly eventName: HookEventName;
  readonly sessionId: string;
  /** `turns.seq` of the attached turn, or `null` for an orphan event. */
  readonly turnSeq: number | null;
  readonly toolName: string | null;
  readonly notificationType: string | null;
  readonly agentType: string | null;
}

/** One turn as shown in the turns panel. Times are epoch ms. */
export interface DebugTurnRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly status: TurnStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly endReason: EndReason | null;
  readonly eventCount: number;
}

export interface DebugServerStatus {
  readonly listening: boolean;
  readonly port: number | null;
}

export interface DebugPrivacyStatus {
  readonly storeRawPrompt: boolean;
}

/** Initial state for the debug view (`awaiting:debug:snapshot`). */
export interface DebugSnapshot {
  /** The newest events, at most `MAX_SNAPSHOT_EVENTS`. */
  readonly events: readonly DebugEventRow[];
  readonly turns: readonly DebugTurnRow[];
  readonly server: DebugServerStatus;
  readonly privacy: DebugPrivacyStatus;
}

/** Incremental push (`awaiting:debug:update`): new events and changed turns. */
export interface DebugUpdate {
  readonly events: readonly DebugEventRow[];
  readonly turns: readonly DebugTurnRow[];
}

export const MAX_SNAPSHOT_EVENTS = 500;
export const MAX_SNAPSHOT_TURNS = 1000;
/** Rows per update batch (events + turns, each). */
export const MAX_UPDATE_ROWS = 200;
/** Upper bound for any string field (session ids are ≤ 256 in core; generous margin). */
export const MAX_DEBUG_STRING = 1024;

type Obj = Record<string, unknown>;

function isPlainObject(x: unknown): x is Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x) as unknown;
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(o: Obj, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return (
    own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))
  );
}

const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isPositiveInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_DEBUG_STRING;
const isNonEmptyStr = (x: unknown): x is string => isStr(x) && x.length > 0;
const isStrOrNull = (x: unknown): boolean => x === null || isStr(x);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (x: unknown): x is T =>
    typeof x === 'string' && (values as readonly string[]).includes(x);

const isHookEventName = oneOf(HOOK_EVENT_NAMES);
const isTurnStatus = oneOf(TURN_STATUSES);
const isEndReason = oneOf(END_REASONS);

const EVENT_ROW_KEYS = [
  'id',
  'receivedAt',
  'eventName',
  'sessionId',
  'turnSeq',
  'toolName',
  'notificationType',
  'agentType',
] as const satisfies readonly (keyof DebugEventRow)[];

const TURN_ROW_KEYS = [
  'sessionId',
  'seq',
  'status',
  'startedAt',
  'endedAt',
  'endReason',
  'eventCount',
] as const satisfies readonly (keyof DebugTurnRow)[];

export function isDebugEventRow(x: unknown): x is DebugEventRow {
  if (!isPlainObject(x) || !hasExactKeys(x, EVENT_ROW_KEYS)) return false;
  return (
    isPositiveInt(x['id']) &&
    isTime(x['receivedAt']) &&
    isHookEventName(x['eventName']) &&
    isNonEmptyStr(x['sessionId']) &&
    (x['turnSeq'] === null || isPositiveInt(x['turnSeq'])) &&
    isStrOrNull(x['toolName']) &&
    isStrOrNull(x['notificationType']) &&
    isStrOrNull(x['agentType'])
  );
}

export function isDebugTurnRow(x: unknown): x is DebugTurnRow {
  if (!isPlainObject(x) || !hasExactKeys(x, TURN_ROW_KEYS)) return false;
  const status = x['status'];
  const endedAt = x['endedAt'];
  const endReason = x['endReason'];
  if (
    !isNonEmptyStr(x['sessionId']) ||
    !isPositiveInt(x['seq']) ||
    !isTurnStatus(status) ||
    !isTime(x['startedAt']) ||
    !(endedAt === null || isTime(endedAt)) ||
    !(endReason === null || isEndReason(endReason)) ||
    !isCount(x['eventCount'])
  ) {
    return false;
  }
  // A running turn has no end; a closed turn has both an end time and a reason.
  return status === 'running'
    ? endedAt === null && endReason === null
    : endedAt !== null && endReason !== null;
}

function isRowArray<T>(x: unknown, max: number, guard: (r: unknown) => r is T): x is T[] {
  return Array.isArray(x) && x.length <= max && x.every((r) => guard(r));
}

export function isDebugUpdate(x: unknown): x is DebugUpdate {
  return (
    isPlainObject(x) &&
    hasExactKeys(x, ['events', 'turns']) &&
    isRowArray(x['events'], MAX_UPDATE_ROWS, isDebugEventRow) &&
    isRowArray(x['turns'], MAX_UPDATE_ROWS, isDebugTurnRow)
  );
}

function isServerStatus(x: unknown): x is DebugServerStatus {
  if (!isPlainObject(x) || !hasExactKeys(x, ['listening', 'port'])) return false;
  const port = x['port'];
  const portOk =
    port === null || (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535);
  return typeof x['listening'] === 'boolean' && portOk;
}

function isPrivacyStatus(x: unknown): x is DebugPrivacyStatus {
  return (
    isPlainObject(x) &&
    hasExactKeys(x, ['storeRawPrompt']) &&
    typeof x['storeRawPrompt'] === 'boolean'
  );
}

export function isDebugSnapshot(x: unknown): x is DebugSnapshot {
  return (
    isPlainObject(x) &&
    hasExactKeys(x, ['events', 'turns', 'server', 'privacy']) &&
    isRowArray(x['events'], MAX_SNAPSHOT_EVENTS, isDebugEventRow) &&
    isRowArray(x['turns'], MAX_SNAPSHOT_TURNS, isDebugTurnRow) &&
    isServerStatus(x['server']) &&
    isPrivacyStatus(x['privacy'])
  );
}
