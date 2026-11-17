// Pure window option builders. Electron is imported as types only, so this module is
// unit-testable under plain-Node Vitest.
import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron';

/** Security-critical webPreferences shared by every window. */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    // Chromium's spellchecker downloads dictionaries from a Google CDN (H2).
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
  };
}

/** The normal, framed main panel window. */
export function mainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 960,
    height: 640,
    show: false,
    title: 'awaiting',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(preloadPath),
  };
}

/** The frameless, transparent, always-on-top avatar window with no taskbar entry. */
export function avatarWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 240,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: secureWebPreferences(preloadPath),
  };
}
