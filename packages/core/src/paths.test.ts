import { describe, expect, it } from 'vitest';
import {
  AWAITING_HOME_ENV,
  DATA_DIR_NAME,
  resolveDataDir,
  separatorForPlatform,
  type DataDirInput,
} from './paths.js';
import * as core from './index.js';

// Contract table: hooks/test/hook.test.js asserts the hook's own copy of the rule against the same rows.
const CONTRACT: readonly [label: string, input: DataDirInput, expected: string][] = [
  [
    'POSIX default',
    { awaitingHome: undefined, homeDir: '/home/alice', sep: '/' },
    '/home/alice/.awaiting',
  ],
  [
    'POSIX empty override',
    { awaitingHome: '', homeDir: '/home/alice', sep: '/' },
    '/home/alice/.awaiting',
  ],
  [
    'POSIX blank override',
    { awaitingHome: '  \t', homeDir: '/home/alice', sep: '/' },
    '/home/alice/.awaiting',
  ],
  ['POSIX override', { awaitingHome: '/tmp/aw', homeDir: '/home/alice', sep: '/' }, '/tmp/aw'],
  [
    'POSIX relative override kept verbatim',
    { awaitingHome: 'rel/dir', homeDir: '/home/alice', sep: '/' },
    'rel/dir',
  ],
  [
    'POSIX override with spaces kept verbatim',
    { awaitingHome: ' /tmp/a b ', homeDir: '/h', sep: '/' },
    ' /tmp/a b ',
  ],
  [
    'POSIX trailing slash on home',
    { awaitingHome: undefined, homeDir: '/home/alice/', sep: '/' },
    '/home/alice/.awaiting',
  ],
  ['POSIX root home', { awaitingHome: undefined, homeDir: '/', sep: '/' }, '/.awaiting'],
  [
    'POSIX backslash in home is not a separator',
    { awaitingHome: undefined, homeDir: '/home/a\\', sep: '/' },
    '/home/a\\/.awaiting',
  ],
  [
    'Windows default',
    { awaitingHome: undefined, homeDir: 'C:\\Users\\alice', sep: '\\' },
    'C:\\Users\\alice\\.awaiting',
  ],
  [
    'Windows empty override',
    { awaitingHome: '', homeDir: 'C:\\Users\\alice', sep: '\\' },
    'C:\\Users\\alice\\.awaiting',
  ],
  [
    'Windows override',
    { awaitingHome: 'D:\\aw', homeDir: 'C:\\Users\\alice', sep: '\\' },
    'D:\\aw',
  ],
  [
    'Windows trailing backslash',
    { awaitingHome: undefined, homeDir: 'C:\\Users\\alice\\', sep: '\\' },
    'C:\\Users\\alice\\.awaiting',
  ],
  [
    'Windows trailing forward slash',
    { awaitingHome: undefined, homeDir: 'C:/Users/alice/', sep: '\\' },
    'C:/Users/alice\\.awaiting',
  ],
  ['Windows drive root', { awaitingHome: undefined, homeDir: 'C:\\', sep: '\\' }, 'C:\\.awaiting'],
  [
    'Windows UNC home',
    { awaitingHome: undefined, homeDir: '\\\\srv\\home\\alice', sep: '\\' },
    '\\\\srv\\home\\alice\\.awaiting',
  ],
];

describe('resolveDataDir', () => {
  it.each(CONTRACT)('%s', (_label, input, expected) => {
    expect(resolveDataDir(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('throws RangeError when homeDir is %s and no override is set', (_label, homeDir) => {
    expect(() => resolveDataDir({ awaitingHome: undefined, homeDir, sep: '/' })).toThrow(
      RangeError,
    );
    expect(() => resolveDataDir({ awaitingHome: '', homeDir, sep: '\\' })).toThrow(RangeError);
  });

  it('does not need homeDir when the override is set', () => {
    expect(resolveDataDir({ awaitingHome: '/x', homeDir: '', sep: '/' })).toBe('/x');
  });

  it('always ends the default path with the data dir name and contains no doubled separator', () => {
    for (const sep of ['/', '\\'] as const) {
      for (const homeDir of ['/a', '/a/', '/a//', 'C:\\a', 'C:\\a\\\\', 'C:\\']) {
        const dir = resolveDataDir({ awaitingHome: undefined, homeDir, sep });
        expect(dir.endsWith(`${sep}${DATA_DIR_NAME}`)).toBe(true);
        expect(dir).not.toContain(`${sep}${sep}${DATA_DIR_NAME}`);
      }
    }
  });

  it('does not mutate its input', () => {
    const input: DataDirInput = { awaitingHome: undefined, homeDir: '/home/a/', sep: '/' };
    const copy = { ...input };
    resolveDataDir(input);
    expect(input).toEqual(copy);
  });
});

describe('separatorForPlatform', () => {
  it.each([
    ['win32', '\\'],
    ['linux', '/'],
    ['darwin', '/'],
    ['freebsd', '/'],
    ['', '/'],
  ])('%s -> %s', (platform, sep) => {
    expect(separatorForPlatform(platform)).toBe(sep);
  });
});

describe('constants and exports', () => {
  it('uses the plan 01 names', () => {
    expect(AWAITING_HOME_ENV).toBe('AWAITING_HOME');
    expect(DATA_DIR_NAME).toBe('.awaiting');
  });

  it('is re-exported from the package entry point', () => {
    expect(core.resolveDataDir).toBe(resolveDataDir);
    expect(core.separatorForPlatform).toBe(separatorForPlatform);
    expect(core.AWAITING_HOME_ENV).toBe(AWAITING_HOME_ENV);
    expect(core.DATA_DIR_NAME).toBe(DATA_DIR_NAME);
  });
});
