import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { DEV_HOST, DEV_PORT, PROD_CSP } from './src/main/policy';

/** Inject the production CSP as a <meta> tag into every built renderer page (build only). */
function cspMetaPlugin(): Plugin {
  return {
    name: 'awaiting:csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: PROD_CSP },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  main: {
    build: {
      // @awaiting/core is consumed as TS source, so bundle it instead of require()-ing it.
      // better-sqlite3 stays external (native module).
      externalizeDeps: { exclude: ['@awaiting/core'] },
      rolldownOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // A sandboxed preload cannot be ESM.
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), cspMetaPlugin()],
    server: { host: DEV_HOST, port: DEV_PORT, strictPort: true },
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          avatar: resolve(__dirname, 'src/renderer/avatar.html'),
        },
      },
    },
  },
});
