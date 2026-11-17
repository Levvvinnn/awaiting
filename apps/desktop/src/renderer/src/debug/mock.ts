// Static mock feed for tests only (state.test.ts); the app uses window.awaiting.debug. Fake ids
// only; timestamps and measured durations, never an estimate (H5).
import type { DebugBridge } from '../../../shared/bridge';
import type { DebugEventRow, DebugSnapshot, DebugTurnRow } from '../../../shared/debug-types';

const BASE = new Date(2026, 10, 17, 10, 0, 0, 0).getTime();
const S1 = 'aaaa1111-mock-session';
const S2 = 'bbbb2222-mock-session';

const events: DebugEventRow[] = [
  {
    id: 1,
    receivedAt: BASE,
    eventName: 'SessionStart',
    sessionId: S1,
    turnSeq: null,
    toolName: null,
    notificationType: null,
    agentType: null,
  },
  {
    id: 2,
    receivedAt: BASE + 1_200,
    eventName: 'UserPromptSubmit',
    sessionId: S1,
    turnSeq: 1,
    toolName: null,
    notificationType: null,
    agentType: null,
  },
  {
    id: 3,
    receivedAt: BASE + 4_310,
    eventName: 'PreToolUse',
    sessionId: S1,
    turnSeq: 1,
    toolName: 'Read',
    notificationType: null,
    agentType: null,
  },
  {
    id: 4,
    receivedAt: BASE + 4_402,
    eventName: 'PostToolUse',
    sessionId: S1,
    turnSeq: 1,
    toolName: 'Read',
    notificationType: null,
    agentType: null,
  },
  {
    id: 5,
    receivedAt: BASE + 9_050,
    eventName: 'SubagentStart',
    sessionId: S1,
    turnSeq: 1,
    toolName: null,
    notificationType: null,
    agentType: 'Explore',
  },
  {
    id: 6,
    receivedAt: BASE + 40_777,
    eventName: 'SubagentStop',
    sessionId: S1,
    turnSeq: 1,
    toolName: null,
    notificationType: null,
    agentType: 'Explore',
  },
  {
    id: 7,
    receivedAt: BASE + 126_200,
    eventName: 'Stop',
    sessionId: S1,
    turnSeq: 1,
    toolName: null,
    notificationType: null,
    agentType: null,
  },
  {
    id: 8,
    receivedAt: BASE + 186_300,
    eventName: 'Notification',
    sessionId: S1,
    turnSeq: null,
    toolName: null,
    notificationType: 'idle_prompt',
    agentType: null,
  },
  {
    id: 9,
    receivedAt: BASE + 200_000,
    eventName: 'UserPromptSubmit',
    sessionId: S2,
    turnSeq: 1,
    toolName: null,
    notificationType: null,
    agentType: null,
  },
  {
    id: 10,
    receivedAt: BASE + 201_500,
    eventName: 'PreToolUse',
    sessionId: S2,
    turnSeq: 1,
    toolName: 'Bash',
    notificationType: null,
    agentType: null,
  },
  {
    id: 11,
    receivedAt: BASE + 202_000,
    eventName: 'PermissionRequest',
    sessionId: S2,
    turnSeq: 1,
    toolName: 'Bash',
    notificationType: null,
    agentType: null,
  },
];

const turns: DebugTurnRow[] = [
  {
    sessionId: S1,
    seq: 1,
    status: 'done',
    startedAt: BASE + 1_200,
    endedAt: BASE + 126_200,
    endReason: 'stop',
    eventCount: 6,
  },
  {
    sessionId: S2,
    seq: 1,
    status: 'running',
    startedAt: BASE + 200_000,
    endedAt: null,
    endReason: null,
    eventCount: 3,
  },
];

export const MOCK_SNAPSHOT: DebugSnapshot = Object.freeze({
  events,
  turns,
  server: { listening: false, port: null },
  privacy: { storeRawPrompt: false },
});

/** A `DebugBridge`-shaped source that serves the static snapshot and never pushes updates. */
export const mockDebugSource: DebugBridge = Object.freeze({
  getSnapshot: () => Promise.resolve(MOCK_SNAPSHOT),
  onUpdate: () => () => undefined,
});
