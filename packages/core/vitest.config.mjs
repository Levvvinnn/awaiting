// Plain .mjs on purpose: core's tsconfig.json has no Node types and covers src/ only,
// so a .ts config would be outside every tsconfig the ESLint project service can find.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
