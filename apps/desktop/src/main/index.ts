import { elapsedMs } from '@awaiting/core';
import { app, BrowserWindow } from 'electron';
import { openDatabase, sqliteVersion } from './db';
import { parseDevOrigin } from './policy';
import { installSecurity } from './security';
import { runSmoke } from './smoke';
import { createWindows, type AppWindows } from './windows/create';

const startedAtMs = Date.now();
const smoke = process.env['AWAITING_SMOKE'] === '1';
const devOrigin = smoke ? null : parseDevOrigin(process.env['ELECTRON_RENDERER_URL']);

let windows: AppWindows | undefined;

function fail(error: unknown): void {
  console.error('awaiting: startup failed:', error);
  app.exit(1);
}

// The smoke run is a separate, short-lived process; it must not hand off to a running instance.
if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const main = windows?.main;
    if (main === undefined || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  });

  app.on('window-all-closed', () => {
    // macOS convention: apps stay alive without windows until Cmd+Q.
    if (process.platform !== 'darwin') app.quit();
  });

  app
    .whenReady()
    .then(() => {
      installSecurity(devOrigin);

      const db = openDatabase(':memory:');
      console.log(`awaiting: sqlite ${sqliteVersion(db)} (in-memory)`);

      windows = createWindows(devOrigin);
      windows.loaded
        .then(() => {
          console.log(`awaiting: windows loaded in ${elapsedMs(startedAtMs, Date.now())} ms`);
        })
        .catch(fail);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length > 0) return;
        windows = createWindows(devOrigin);
        windows.loaded.catch((error: unknown) => {
          console.error('awaiting: window reload failed:', error);
        });
      });

      if (smoke) runSmoke(db, windows);
    })
    .catch(fail);
}
