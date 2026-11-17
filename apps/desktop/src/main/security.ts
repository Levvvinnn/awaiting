import { app, session } from 'electron';
import { devCsp, isAllowedNavigation, isAllowedRequestUrl } from './policy';

/**
 * Install app-wide security handlers. Call once after `app.whenReady()` and before any window
 * is created. `devOrigin` is the validated dev-server origin, or null in production.
 */
export function installSecurity(devOrigin: string | null): void {
  app.on('web-contents-created', (_event, contents) => {
    // No popups, ever. External links (M1+) go through shell.openExternal after an allowlist check.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    contents.on('will-navigate', (event) => {
      if (!isAllowedNavigation(event.url, contents.getURL())) event.preventDefault();
    });
    contents.on('will-redirect', (event) => {
      event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });

  const ses = session.defaultSession;

  // Deny every permission (camera, notifications via web API, geolocation, ...).
  ses.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);

  // H2 defense in depth: cancel any request that is not local (or the dev server in dev).
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequestUrl(details.url, devOrigin) });
  });

  // Dev only: the dev server's pages carry no meta CSP, so send it as a header instead.
  if (devOrigin !== null) {
    const policy = devCsp(devOrigin);
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [policy],
        },
      });
    });
  }
}
