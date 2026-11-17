/**
 * The complete renderer-visible API exposed by the preload script as `window.awaiting`.
 * Frozen in M0: no IPC, no Node APIs. Every addition must be narrow, typed and validated
 * in the main process.
 */
export interface AwaitingBridge {
  readonly bridgeVersion: 1;
}
