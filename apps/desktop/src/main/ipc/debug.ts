// Debug-view IPC (plan 01 §3.9): one invoke handler for the snapshot, and batched pushes to the
// main window only. Channels are fixed in src/shared/bridge.ts; the preload validates again.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { DEBUG_SNAPSHOT_CHANNEL, DEBUG_UPDATE_CHANNEL } from '../../shared/bridge';
import type { DebugSnapshot, DebugUpdate } from '../../shared/debug-types';
import { createUpdateBatcher, type UpdateBatcher } from './debug-batch';
import { isMainWindowSender } from './sender';

export interface DebugIpcOptions {
  /** The current main window (it can be re-created on macOS `activate`). */
  readonly getMainWindow: () => BrowserWindow | undefined;
  /** Builds a validated snapshot (`buildDebugSnapshot`). */
  readonly snapshot: () => DebugSnapshot;
  /** Errors and refusals, as short messages without payload content. */
  readonly onError?: (message: string) => void;
}

export interface DebugIpc {
  /** Queue an update for the main window (coalesced for ≤ 100 ms). */
  push(update: DebugUpdate): void;
  /** Send whatever is queued now. */
  flush(): void;
  /** Remove the handler and drop anything queued. Idempotent. */
  dispose(): void;
  readonly batcher: UpdateBatcher;
}

export function registerDebugIpc(opts: DebugIpcOptions): DebugIpc {
  const report = opts.onError ?? (() => undefined);

  ipcMain.handle(DEBUG_SNAPSHOT_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isMainWindowSender(event, opts.getMainWindow())) {
      report('debug snapshot refused: sender is not the main window');
      throw new Error('awaiting: not allowed');
    }
    if (args.length !== 0) {
      report('debug snapshot refused: unexpected arguments');
      throw new Error('awaiting: invalid request');
    }
    return opts.snapshot();
  });

  const batcher = createUpdateBatcher({
    send: (update) => {
      const main = opts.getMainWindow();
      if (main === undefined || main.isDestroyed() || main.webContents.isDestroyed()) return false;
      main.webContents.send(DEBUG_UPDATE_CHANNEL, update);
      return true;
    },
    onInvalid: (n) => {
      report(`debug update: dropped ${String(n)} invalid chunk(s)`);
    },
  });

  let disposed = false;
  return {
    push: (update) => {
      batcher.push(update);
    },
    flush: () => {
      batcher.flush();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      batcher.dispose();
      ipcMain.removeHandler(DEBUG_SNAPSHOT_CHANNEL);
    },
    batcher,
  };
}
