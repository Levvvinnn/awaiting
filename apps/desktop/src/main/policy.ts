// Pure security policy: CSP strings and URL allow-rules. No Electron import, so it is
// unit-testable under Vitest and importable from electron.vite.config.ts.

/** The only origin the dev renderer may be served from (electron-vite dev server). */
export const DEV_HOST = '127.0.0.1';
export const DEV_PORT = 5173;

function serialize(directives: Record<string, string>): string {
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

const PROD_DIRECTIVES: Record<string, string> = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self' data:",
  'font-src': "'self'",
  'connect-src': "'none'",
  'media-src': "'self'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'frame-src': "'none'",
};

/**
 * Production CSP, injected as a `<meta>` tag into the built renderer HTML.
 * No `frame-ancestors`: browsers ignore it in a meta CSP (and Chromium warns). The window
 * open/navigation handlers and `frame-src 'none'` cover framing instead.
 */
export const PROD_CSP = serialize(PROD_DIRECTIVES);

/**
 * Development CSP, sent as a response header for dev-server pages only.
 * `'unsafe-inline'` scripts: React Refresh preamble. `'unsafe-inline'` styles: Vite injects
 * CSS as `<style>` elements during HMR. connect-src: the HMR socket. Never `'unsafe-eval'`.
 */
export function devCsp(devOrigin: string): string {
  const wsOrigin = devOrigin.replace(/^http/, 'ws');
  return serialize({
    ...PROD_DIRECTIVES,
    'script-src': "'self' 'unsafe-inline'",
    'style-src': "'self' 'unsafe-inline'",
    'connect-src': `${devOrigin} ${wsOrigin}`,
    // Honoured here because the dev CSP is a response header, not a meta tag.
    'frame-ancestors': "'none'",
  });
}

/**
 * Parse `ELECTRON_RENDERER_URL` into the dev origin, accepting only the loopback dev server.
 * Returns null when unset or not exactly http://127.0.0.1:5173 (then the app runs as prod).
 */
export function parseDevOrigin(rendererUrl: string | undefined): string | null {
  if (rendererUrl === undefined || rendererUrl === '') return null;
  let url: URL;
  try {
    url = new URL(rendererUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.hostname !== DEV_HOST || url.port !== String(DEV_PORT)) {
    return null;
  }
  return url.origin;
}

/** Schemes the renderer may always request (local files, devtools, inline data). */
const ALWAYS_ALLOWED_SCHEMES = new Set(['file:', 'devtools:', 'data:']);

/**
 * Session-level request filter (defense in depth for H2): allow local schemes, plus the
 * dev server's http/ws origin while developing. Everything else is cancelled.
 */
export function isAllowedRequestUrl(rawUrl: string, devOrigin: string | null): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (ALWAYS_ALLOWED_SCHEMES.has(url.protocol)) return true;
  if (devOrigin === null) return false;
  const dev = new URL(devOrigin);
  return (url.protocol === 'http:' || url.protocol === 'ws:') && url.host === dev.host;
}

/**
 * Navigation rule: a window may only "navigate" to the URL it already shows (e.g. a reload or
 * an in-page hash change of the same document). Any other target is blocked.
 */
export function isAllowedNavigation(targetUrl: string, currentUrl: string): boolean {
  const strip = (u: string): string => u.split('#', 1)[0] ?? u;
  return currentUrl !== '' && strip(targetUrl) === strip(currentUrl);
}
