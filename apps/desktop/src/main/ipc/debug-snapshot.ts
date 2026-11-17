// Builds the debug-view snapshot from the store and the server status (plan 01 §3.9). No
// Electron import, so it is unit-tested against a real temp-file store.
import {
  MAX_SNAPSHOT_EVENTS,
  MAX_SNAPSHOT_TURNS,
  isDebugSnapshot,
  type DebugServerStatus,
  type DebugSnapshot,
} from '../../shared/debug-types';
import type { Repo } from '../store/repo';

/** Closed turns younger than this are included (running turns always are). */
export const SNAPSHOT_TURN_WINDOW_MS = 24 * 60 * 60 * 1000;

export const SERVER_NOT_LISTENING: DebugServerStatus = Object.freeze({
  listening: false,
  port: null,
});

export interface SnapshotSource {
  readonly repo: Pick<Repo, 'recentEvents' | 'currentTurns' | 'getSetting'>;
  readonly server: () => DebugServerStatus;
  readonly now: () => number;
}

/** The snapshot, already checked with the shared validator. Throws if it does not validate. */
export function buildDebugSnapshot(src: SnapshotSource): DebugSnapshot {
  const snapshot: DebugSnapshot = {
    events: src.repo.recentEvents(MAX_SNAPSHOT_EVENTS),
    turns: src.repo.currentTurns(src.now() - SNAPSHOT_TURN_WINDOW_MS).slice(0, MAX_SNAPSHOT_TURNS),
    server: src.server(),
    privacy: { storeRawPrompt: src.repo.getSetting('privacy.storeRawPrompt') },
  };
  if (!isDebugSnapshot(snapshot)) throw new Error('awaiting: debug snapshot failed validation');
  return snapshot;
}
