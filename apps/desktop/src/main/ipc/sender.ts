// IPC sender check (plan 01 §3.9), kept free of Electron imports so it is unit-tested with fakes.
// Structural types: only the identity of the objects matters.

export interface SenderLike {
  readonly mainFrame: unknown;
}

export interface InvokeEventLike {
  readonly sender: SenderLike;
  readonly senderFrame: unknown;
}

export interface WindowLike {
  isDestroyed(): boolean;
  readonly webContents: SenderLike;
}

/**
 * True only for an invoke from the top frame of the current main window's own webContents.
 * The avatar window, a destroyed or replaced main window, and any subframe are refused.
 */
export function isMainWindowSender(event: InvokeEventLike, main: WindowLike | undefined): boolean {
  if (main === undefined || main.isDestroyed()) return false;
  if (event.sender !== main.webContents) return false;
  const frame = event.senderFrame;
  return frame !== null && frame !== undefined && frame === event.sender.mainFrame;
}
