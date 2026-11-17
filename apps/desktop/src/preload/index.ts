import { contextBridge } from 'electron';
import type { AwaitingBridge } from '../shared/bridge';

export type { AwaitingBridge };

// The narrowest useful bridge: a frozen object with no functions, no IPC and no Node APIs.
contextBridge.exposeInMainWorld(
  'awaiting',
  Object.freeze({ bridgeVersion: 1 } satisfies AwaitingBridge),
);
