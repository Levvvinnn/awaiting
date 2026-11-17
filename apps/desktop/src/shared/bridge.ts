import type { DebugSnapshot, DebugUpdate } from './debug-types';

/** IPC channels, hard-coded in the preload; the renderer never names a channel. */
export const DEBUG_SNAPSHOT_CHANNEL = 'awaiting:debug:snapshot';
export const DEBUG_UPDATE_CHANNEL = 'awaiting:debug:update';

/**
 * Passed to the main window only (webPreferences.additionalArguments). The preload exposes
 * `debug` only when it sees it; main additionally checks `event.sender` on every invoke.
 */
export const MAIN_WINDOW_ARG = '--awaiting-window=main';

/** Read-only debug feed for the main window (plan 01 §3.9). Payloads are validated in the preload. */
export interface DebugBridge {
  /** The current snapshot; rejects if main refuses or the payload fails validation. */
  getSnapshot(): Promise<DebugSnapshot>;
  /** Subscribe to validated update batches. Returns an unsubscribe function. */
  onUpdate(listener: (update: DebugUpdate) => void): () => void;
}

/**
 * The complete renderer-visible API exposed by the preload script as `window.awaiting`.
 * Every addition must be narrow, typed and validated in the main process. No raw IPC and no
 * Node APIs are ever exposed.
 */
export interface AwaitingBridge {
  readonly bridgeVersion: 2;
  /** Present in the main window only; `undefined` in the avatar window. */
  readonly debug?: DebugBridge;
}
