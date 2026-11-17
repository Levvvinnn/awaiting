// Self-test for the lint guard rails (core purity + H2 network ban).
// Lints in-memory snippets at virtual paths and fails if an expected error is missing,
// or if a known-clean snippet is flagged. Writes no files.
import { ESLint } from 'eslint';

const RULES = new Set([
  'no-restricted-imports',
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-syntax',
  'no-console',
]);

/** @type {{ name: string; filePath: string; code: string; expectError: boolean }[]} */
const cases = [
  {
    name: 'core: node:fs import',
    filePath: 'packages/core/src/__guard__.mjs',
    code: "import fs from 'node:fs';\nexport default fs;\n",
    expectError: true,
  },
  {
    name: 'core: fs import',
    filePath: 'packages/core/src/__guard__.mjs',
    code: "import fs from 'fs';\nexport default fs;\n",
    expectError: true,
  },
  {
    name: 'core: Date.now()',
    filePath: 'packages/core/src/__guard__.mjs',
    code: 'export const t = Date.now();\n',
    expectError: true,
  },
  {
    name: 'core: new Date()',
    filePath: 'packages/core/src/__guard__.mjs',
    code: 'export const t = new Date();\n',
    expectError: true,
  },
  {
    name: 'core: Math.random()',
    filePath: 'packages/core/src/__guard__.mjs',
    code: 'export const r = Math.random();\n',
    expectError: true,
  },
  {
    name: 'core: better-sqlite3',
    filePath: 'packages/core/src/__guard__.mjs',
    code: "import Database from 'better-sqlite3';\nexport default Database;\n",
    expectError: true,
  },
  {
    name: 'core: electron',
    filePath: 'packages/core/src/__guard__.mjs',
    code: "import { app } from 'electron';\nexport default app;\n",
    expectError: true,
  },
  {
    name: 'renderer: fetch',
    filePath: 'apps/desktop/src/renderer/__guard__.mjs',
    code: "export const p = fetch('https://x');\n",
    expectError: true,
  },
  {
    name: 'main: node:https',
    filePath: 'apps/desktop/src/main/__guard__.mjs',
    code: "import https from 'node:https';\nexport default https;\n",
    expectError: true,
  },
  {
    name: 'main: electron net',
    filePath: 'apps/desktop/src/main/__guard__.mjs',
    code: "import { net } from 'electron';\nexport default net;\n",
    expectError: true,
  },
  {
    name: 'main: node:http outside server/',
    filePath: 'apps/desktop/src/main/__guard__.mjs',
    code: "import http from 'node:http';\nexport default http;\n",
    expectError: true,
  },
  {
    name: 'cli: axios',
    filePath: 'packages/cli/src/__guard__.mjs',
    code: "import axios from 'axios';\nexport default axios;\n",
    expectError: true,
  },
  // Bypasses: CommonJS require(), dynamic import(), global-object access, default electron import.
  {
    name: 'hooks (CJS): require node:https',
    filePath: 'hooks/__guard__.js',
    code: "const https = require('node:https');\nmodule.exports = https;\n",
    expectError: true,
  },
  {
    name: 'cjs: require https',
    filePath: 'scripts/__guard__.cjs',
    code: "module.exports = require('https');\n",
    expectError: true,
  },
  {
    name: 'cjs: require @sentry/node',
    filePath: 'scripts/__guard__.cjs',
    code: "module.exports = require('@sentry/node');\n",
    expectError: true,
  },
  {
    name: 'cjs: destructure net from electron',
    filePath: 'scripts/__guard__.cjs',
    code: "const { net } = require('electron');\nmodule.exports = net;\n",
    expectError: true,
  },
  {
    name: 'main: dynamic import node:https',
    filePath: 'apps/desktop/src/main/__guard__.mjs',
    code: "export const m = import('node:https');\n",
    expectError: true,
  },
  {
    name: 'main: dynamic import node:http outside server/',
    filePath: 'apps/desktop/src/main/__guard__.mjs',
    code: "export const m = import('node:http');\n",
    expectError: true,
  },
  {
    name: 'renderer: globalThis.fetch',
    filePath: 'apps/desktop/src/renderer/__guard__.mjs',
    code: "export const p = globalThis.fetch('https://x');\n",
    expectError: true,
  },
  {
    name: 'renderer: window.fetch',
    filePath: 'apps/desktop/src/renderer/__guard__.mjs',
    code: "export const p = window.fetch('https://x');\n",
    expectError: true,
  },
  {
    name: 'main: default electron import',
    filePath: 'apps/desktop/src/main/__guard__.mjs',
    code: "import electron from 'electron';\nexport const n = electron.net;\n",
    expectError: true,
  },
  {
    name: 'core: Date() call',
    filePath: 'packages/core/src/__guard__.mjs',
    code: 'export const t = Date();\n',
    expectError: true,
  },
  {
    name: 'core: globalThis.Date.now()',
    filePath: 'packages/core/src/__guard__.mjs',
    code: 'export const t = globalThis.Date.now();\n',
    expectError: true,
  },
  // Real .ts files, linted through the typed (projectService) config.
  {
    name: 'core .ts: node:fs import',
    filePath: 'packages/core/src/time.ts',
    code: "import fs from 'node:fs';\nexport default fs;\n",
    expectError: true,
  },
  {
    name: 'core .ts: Date.now()',
    filePath: 'packages/core/src/time.ts',
    code: 'export const t: number = Date.now();\n',
    expectError: true,
  },
  {
    name: 'main .ts: electron net',
    filePath: 'apps/desktop/src/main/db.ts',
    code: "import { net } from 'electron';\nexport default net;\n",
    expectError: true,
  },
  {
    name: 'core .ts: pure fn allowed',
    filePath: 'packages/core/src/time.ts',
    code: 'export const f = (now: number): number => now + 1;\n',
    expectError: false,
  },
  {
    name: 'hooks (CJS): require node:http allowed',
    filePath: 'hooks/__guard__.js',
    code: "const http = require('node:http');\nmodule.exports = http;\n",
    expectError: false,
  },
  {
    name: 'main: named electron import allowed',
    filePath: 'apps/desktop/src/main/__guard__.mjs',
    code: "import { app } from 'electron';\nexport default app;\n",
    expectError: false,
  },
  // M1: hook dependency/output rules, CLI and server boundaries.
  {
    name: 'hooks: require non-builtin',
    filePath: 'hooks/__guard__.js',
    code: "const lp = require('left-pad');\nmodule.exports = lp;\n",
    expectError: true,
  },
  {
    name: 'hooks: console.log',
    filePath: 'hooks/__guard__.js',
    code: 'console.log(1);\n',
    expectError: true,
  },
  {
    name: 'cli: node:http outside doctor probe',
    filePath: 'packages/cli/src/__guard__.mjs',
    code: "import http from 'node:http';\nexport default http;\n",
    expectError: true,
  },
  {
    name: 'server: node:https still banned',
    filePath: 'apps/desktop/src/main/server/__guard__.mjs',
    code: "import https from 'node:https';\nexport default https;\n",
    expectError: true,
  },
  {
    name: 'server: node:http allowed',
    filePath: 'apps/desktop/src/main/server/__guard__.mjs',
    code: "import http from 'node:http';\nexport default http;\n",
    expectError: false,
  },
  {
    name: 'core: pure fn allowed',
    filePath: 'packages/core/src/__guard__.mjs',
    code: 'export const f = (now) => now + 1;\n',
    expectError: false,
  },
];

const eslint = new ESLint();
let failures = 0;
for (const c of cases) {
  const [result] = await eslint.lintText(c.code, { filePath: c.filePath, warnIgnored: true });
  const hits = (result?.messages ?? []).filter(
    (m) => m.severity === 2 && m.ruleId && RULES.has(m.ruleId),
  );
  const fatal = (result?.messages ?? []).filter((m) => m.fatal);
  const ok = fatal.length === 0 && (c.expectError ? hits.length > 0 : hits.length === 0);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${c.name}: expected ${c.expectError ? 'an error' : 'no error'}, got`,
      [...fatal, ...hits].map((m) => m.message),
    );
  }
}
if (failures > 0) {
  console.error(`check-lint-guards: ${failures}/${cases.length} cases failed`);
  process.exit(1);
}
console.log(`check-lint-guards: ${cases.length} cases ok`);
