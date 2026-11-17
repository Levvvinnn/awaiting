import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  DEBUG_SNAPSHOT_CHANNEL,
  DEBUG_UPDATE_CHANNEL,
  MAIN_WINDOW_ARG,
  type AwaitingBridge,
  type DebugBridge,
} from '../shared/bridge';
import { isDebugSnapshot, isDebugUpdate, type DebugUpdate } from '../shared/debug-types';

export type { AwaitingBridge };

// Narrow, frozen bridge. Channels are fixed here; the renderer can neither name a channel nor
// receive an IpcRendererEvent. Every payload from main is validated before it is handed over.
const debug: DebugBridge = Object.freeze({
  async getSnapshot() {
    const payload: unknown = await ipcRenderer.invoke(DEBUG_SNAPSHOT_CHANNEL);
    if (!isDebugSnapshot(payload)) throw new Error('awaiting: invalid debug snapshot');
    return payload;
  },
  onUpdate(listener: (update: DebugUpdate) => void) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (isDebugUpdate(payload)) listener(payload);
    };
    ipcRenderer.on(DEBUG_UPDATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(DEBUG_UPDATE_CHANNEL, handler);
    };
  },
});

const isMainWindow = process.argv.includes(MAIN_WINDOW_ARG);

const bridge: AwaitingBridge = isMainWindow ? { bridgeVersion: 2, debug } : { bridgeVersion: 2 };

contextBridge.exposeInMainWorld('awaiting', Object.freeze(bridge));
