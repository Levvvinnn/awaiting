// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const H2 = 'H2: no outbound network (CLAUDE.md hard rule 2).';
const PURE =
  'packages/core is pure: no I/O, no clock, no randomness (CLAUDE.md "Where code goes").';

/** Outbound-network modules banned everywhere. */
const networkPaths = [
  ...['https', 'http2', 'tls', 'dgram'].flatMap((m) => [
    { name: m, message: H2 },
    { name: `node:${m}`, message: H2 },
  ]),
  ...['undici', 'node-fetch', 'axios', 'got', 'ws'].map((name) => ({ name, message: H2 })),
  {
    name: 'electron',
    importNames: ['net', 'netLog', 'crashReporter', 'autoUpdater'],
    message: H2,
  },
  {
    name: 'electron',
    importNames: ['default'],
    message: `${H2} Use named imports from 'electron' so the net/crashReporter/autoUpdater ban can see them.`,
  },
];
const networkPatterns = [
  { group: ['@sentry/*', 'posthog*', 'mixpanel*', '@segment/*'], message: H2 },
];
/** Raw sockets / http: allowed only where M1's loopback server and the hook live. */
const socketPaths = ['http', 'net'].flatMap((m) => [
  { name: m, message: `${H2} Only allowed in apps/desktop/src/main/server and hooks/.` },
  { name: `node:${m}`, message: `${H2} Only allowed in apps/desktop/src/main/server and hooks/.` },
]);

const networkGlobals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
  name,
  message: H2,
}));
const networkProperties = [
  { object: 'navigator', property: 'sendBeacon', message: H2 },
  // Same globals reached through a global object (globalThis.fetch, window.fetch, ...).
  ...['globalThis', 'window', 'self', 'global'].flatMap((object) =>
    ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((property) => ({
      object,
      property,
      message: H2,
    })),
  ),
];

// no-restricted-imports only sees static ESM imports. These selectors cover CommonJS
// require() (hooks/ is CJS) and dynamic import() with the same banned module names.
const NET_MODULES = String.raw`^(node:)?(https|http2|tls|dgram)$|^(undici|node-fetch|axios|got|ws)$|^(@sentry|@segment)\x2F|^(posthog|mixpanel)`; // \x2F = "/" (a literal slash would end the esquery regex)
const SOCKET_MODULES = String.raw`^(node:)?(http|net)$`;
const ELECTRON_NET = String.raw`^(net|netLog|crashReporter|autoUpdater)$`;
/** @param {string} re @param {string} message */
const moduleCallSelectors = (re, message) => [
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/${re}/]`, message },
  { selector: `ImportExpression[source.value=/${re}/]`, message },
];
const networkSyntax = [
  ...moduleCallSelectors(NET_MODULES, H2),
  {
    selector: `MemberExpression[object.callee.name='require'][object.arguments.0.value='electron'][property.name=/${ELECTRON_NET}/]`,
    message: H2,
  },
  {
    selector: `VariableDeclarator[init.callee.name='require'][init.arguments.0.value='electron'] > ObjectPattern > Property[key.name=/${ELECTRON_NET}/]`,
    message: H2,
  },
];
const socketSyntax = moduleCallSelectors(
  SOCKET_MODULES,
  `${H2} Only allowed in apps/desktop/src/main/server and hooks/.`,
);

const coreBannedModules = [
  ...builtinModules.filter((m) => !m.startsWith('_')).map((name) => ({ name, message: PURE })),
  ...['electron', 'better-sqlite3', '@awaiting/cli', 'desktop'].map((name) => ({
    name,
    message: PURE,
  })),
];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/coverage/**', 'pnpm-lock.yaml'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Node environments
  {
    files: [
      '*.{js,mjs,cjs,ts}',
      'scripts/**',
      'apps/desktop/scripts/**',
      'apps/desktop/src/main/**',
      'apps/desktop/src/preload/**',
      'apps/desktop/*.{js,mjs,ts}',
      'packages/cli/**',
      'packages/*/*.{js,mjs,ts}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/desktop/src/renderer/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['hooks/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  // H2: repo-wide outbound network ban
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...networkPaths, ...socketPaths], patterns: networkPatterns },
      ],
      'no-restricted-globals': ['error', ...networkGlobals],
      'no-restricted-properties': ['error', ...networkProperties],
      'no-restricted-syntax': ['error', ...networkSyntax, ...socketSyntax],
    },
  },
  // http/net allowed (loopback server + hook, M1)
  {
    files: ['apps/desktop/src/main/server/**', 'hooks/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: networkPaths, patterns: networkPatterns }],
      'no-restricted-syntax': ['error', ...networkSyntax],
    },
  },
  // Core purity (also applies to core tests)
  {
    files: ['packages/core/**/*.{ts,tsx,js,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...networkPaths, ...socketPaths, ...coreBannedModules],
          patterns: [...networkPatterns, { group: ['node:*'], message: PURE }],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...networkGlobals,
        ...[
          'process',
          'require',
          'setTimeout',
          'setInterval',
          'setImmediate',
          'queueMicrotask',
          'performance',
          'crypto',
          // Global objects are an escape hatch around every rule here (globalThis.Date.now()).
          'globalThis',
          'global',
          'window',
          'self',
        ].map((name) => ({ name, message: PURE })),
      ],
      'no-restricted-properties': [
        'error',
        ...networkProperties,
        { object: 'Date', property: 'now', message: `${PURE} Pass \`now\` in.` },
        { object: 'performance', property: 'now', message: `${PURE} Pass \`now\` in.` },
        { object: 'Math', property: 'random', message: PURE },
      ],
      'no-restricted-syntax': [
        'error',
        ...networkSyntax,
        ...socketSyntax,
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: `${PURE} Pass \`now\` in.`,
        },
        {
          // Date() without `new` returns the current time as a string.
          selector: "CallExpression[callee.name='Date']",
          message: `${PURE} Pass \`now\` in.`,
        },
        { selector: 'ImportExpression', message: `${PURE} No dynamic import().` },
      ],
    },
  },
  // Config files for packages/core run under Node (vitest.config.ts); keep them out of the purity rules.
  {
    files: ['packages/core/*.config.{ts,mjs,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...networkPaths, ...socketPaths], patterns: networkPatterns },
      ],
      'no-restricted-globals': ['error', ...networkGlobals],
      'no-restricted-properties': ['error', ...networkProperties],
      'no-restricted-syntax': ['error', ...networkSyntax, ...socketSyntax],
    },
  },
);
