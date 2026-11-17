import { describe, expect, it } from 'vitest';
import {
  PROD_CSP,
  devCsp,
  isAllowedNavigation,
  isAllowedRequestUrl,
  parseDevOrigin,
} from './policy';

const DEV = 'http://127.0.0.1:5173';

describe('PROD_CSP', () => {
  it('is strict: no remote content, no inline, no eval', () => {
    expect(PROD_CSP).toContain("default-src 'none'");
    expect(PROD_CSP).toContain("script-src 'self'");
    expect(PROD_CSP).toContain("connect-src 'none'");
    expect(PROD_CSP).toContain("object-src 'none'");
    expect(PROD_CSP).toContain("frame-src 'none'");
    // frame-ancestors is ignored in a meta CSP; it must only appear in the dev header.
    expect(PROD_CSP).not.toContain('frame-ancestors');
    expect(PROD_CSP).not.toMatch(/unsafe-(inline|eval)/);
    expect(PROD_CSP).not.toMatch(/https?:|\*/);
  });
});

describe('devCsp', () => {
  it('only adds what Vite HMR needs and never unsafe-eval', () => {
    const csp = devCsp(DEV);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain(`connect-src ${DEV} ws://127.0.0.1:5173`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('parseDevOrigin', () => {
  it('accepts only the loopback dev server', () => {
    expect(parseDevOrigin('http://127.0.0.1:5173')).toBe(DEV);
    expect(parseDevOrigin('http://127.0.0.1:5173/')).toBe(DEV);
  });
  it.each([
    undefined,
    '',
    'not a url',
    'http://localhost:5173',
    'http://0.0.0.0:5173',
    'http://[::1]:5173',
    'https://127.0.0.1:5173',
    'http://127.0.0.1:8080',
    'http://example.com:5173',
  ])('rejects %s', (value) => {
    expect(parseDevOrigin(value)).toBeNull();
  });
});

describe('isAllowedRequestUrl', () => {
  it('allows local schemes in prod', () => {
    expect(isAllowedRequestUrl('file:///C:/app/out/renderer/index.html', null)).toBe(true);
    expect(isAllowedRequestUrl('devtools://devtools/bundled/x.html', null)).toBe(true);
    expect(isAllowedRequestUrl('data:image/png;base64,AAAA', null)).toBe(true);
  });
  it('blocks every remote request in prod', () => {
    for (const url of [
      'https://example.com/',
      'http://127.0.0.1:5173/',
      'ws://127.0.0.1:5173/',
      'http://127.0.0.1:47123/events',
      'blob:https://example.com/x',
      'garbage',
    ]) {
      expect(isAllowedRequestUrl(url, null)).toBe(false);
    }
  });
  it('allows only the dev origin in dev', () => {
    expect(isAllowedRequestUrl('http://127.0.0.1:5173/@vite/client', DEV)).toBe(true);
    expect(isAllowedRequestUrl('ws://127.0.0.1:5173/', DEV)).toBe(true);
    expect(isAllowedRequestUrl('https://127.0.0.1:5173/', DEV)).toBe(false);
    expect(isAllowedRequestUrl('http://127.0.0.1:5174/', DEV)).toBe(false);
    expect(isAllowedRequestUrl('https://fonts.googleapis.com/css', DEV)).toBe(false);
  });
});

describe('isAllowedNavigation', () => {
  it('allows only the current document', () => {
    expect(isAllowedNavigation(`${DEV}/index.html`, `${DEV}/index.html`)).toBe(true);
    expect(isAllowedNavigation(`${DEV}/index.html#a`, `${DEV}/index.html`)).toBe(true);
    expect(isAllowedNavigation(`${DEV}/avatar.html`, `${DEV}/index.html`)).toBe(false);
    expect(isAllowedNavigation('https://example.com/', `${DEV}/index.html`)).toBe(false);
    expect(isAllowedNavigation('file:///etc/passwd', 'file:///app/index.html')).toBe(false);
    expect(isAllowedNavigation('https://example.com/', '')).toBe(false);
  });
});
