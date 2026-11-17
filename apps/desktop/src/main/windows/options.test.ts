import { describe, expect, it } from 'vitest';
import { avatarWindowOptions, mainWindowOptions, secureWebPreferences } from './options';
import { MAIN_WINDOW_ARG } from '../../shared/bridge';

const PRELOAD = '/app/out/preload/index.js';

const windows = {
  main: mainWindowOptions(PRELOAD),
  avatar: avatarWindowOptions(PRELOAD),
};

describe('secureWebPreferences', () => {
  it('sets the preload path', () => {
    expect(secureWebPreferences(PRELOAD).preload).toBe(PRELOAD);
  });
});

describe.each(Object.entries(windows))('%s window', (_name, options) => {
  it('uses the secure Electron defaults', () => {
    expect(options.webPreferences).toMatchObject({
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    });
  });

  it('is created hidden (shown on ready-to-show)', () => {
    expect(options.show).toBe(false);
  });
});

describe('avatar window', () => {
  it('is frameless, transparent, always on top and has no taskbar entry', () => {
    expect(windows.avatar).toMatchObject({
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
    });
  });
});

describe('main window', () => {
  it('keeps a normal frame and taskbar entry', () => {
    expect(windows.main.frame).not.toBe(false);
    expect(windows.main.transparent).not.toBe(true);
    expect(windows.main.skipTaskbar).not.toBe(true);
    expect(windows.main.alwaysOnTop).not.toBe(true);
  });
});

describe('debug API marker', () => {
  it('is passed to the main window only', () => {
    expect(windows.main.webPreferences?.additionalArguments).toEqual([MAIN_WINDOW_ARG]);
    expect(windows.avatar.webPreferences?.additionalArguments).toBeUndefined();
  });
});
