import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { avatarWindowOptions, mainWindowOptions } from './options';

export interface AppWindows {
  readonly main: BrowserWindow;
  readonly avatar: BrowserWindow;
  /** Resolves once both renderers have finished loading; rejects if either load fails. */
  readonly loaded: Promise<void>;
}

type Page = 'index' | 'avatar';

function load(win: BrowserWindow, page: Page, devOrigin: string | null): Promise<void> {
  if (devOrigin !== null) {
    // Dev only: surface renderer warnings/errors (e.g. CSP violations) in the terminal.
    win.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
      if (level === 'warning' || level === 'error') {
        console.log(`[renderer:${page}] ${level}: ${message} (${sourceId}:${lineNumber})`);
      }
    });
    return win.loadURL(`${devOrigin}/${page}.html`);
  }
  return win.loadFile(join(__dirname, '../renderer', `${page}.html`));
}

/** Create the main panel and the avatar window. Position, drag and click-through are M3. */
export function createWindows(devOrigin: string | null): AppWindows {
  const preload = join(__dirname, '../preload/index.js');

  const main = new BrowserWindow(mainWindowOptions(preload));
  const avatar = new BrowserWindow(avatarWindowOptions(preload));
  avatar.setAlwaysOnTop(true, 'floating');

  main.once('ready-to-show', () => {
    main.show();
  });
  // showInactive: the avatar must never steal focus from the user's work.
  avatar.once('ready-to-show', () => {
    avatar.showInactive();
  });

  const loaded = Promise.all([
    load(main, 'index', devOrigin),
    load(avatar, 'avatar', devOrigin),
  ]).then(() => undefined);

  return { main, avatar, loaded };
}
