// Bundles the CLI into one CommonJS file that runs on plain `node` >= 20 (plan 01 §3.10, D1.12).
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/bin.ts',
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'awaiting.cjs',
        banner: '#!/usr/bin/env node',
      },
    },
  },
  ssr: {
    noExternal: ['@awaiting/core'],
  },
});
