import type { AwaitingBridge } from '../../shared/bridge';

declare global {
  interface Window {
    /** Exposed by the preload script; see src/shared/bridge.ts. */
    readonly awaiting: AwaitingBridge;
  }
}

export {};
