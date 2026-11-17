// server.json (the hook-side contract is exercised end to end in http.test.ts): shape, atomic write, 0600 on POSIX, pid-matched removal.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToken } from './auth';
import {
  SERVER_FILE_NAME,
  readServerInfo,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
  type ServerInfo,
} from './runtime-file';

const POSIX = process.platform !== 'win32';

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'awaiting-runtime-'));
  dataDir = join(root, 'nested', '.awaiting');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const info = (over: Partial<ServerInfo> = {}): ServerInfo => ({
  version: 1,
  port: 43210,
  token: generateToken(),
  pid: process.pid,
  startedAt: 1_763_300_000_000,
  ...over,
});

describe('writeServerInfo', () => {
  it('creates the data dir and writes exactly { version, port, token, pid, startedAt }', () => {
    const i = info();
    writeServerInfo(dataDir, { ...i, extra: 'dropped' } as ServerInfo);
    const parsed = JSON.parse(readFileSync(serverInfoPath(dataDir), 'utf8')) as unknown;
    expect(parsed).toEqual(i);
    expect(Object.keys(parsed as object)).toEqual(['version', 'port', 'token', 'pid', 'startedAt']);
    expect(readServerInfo(dataDir)).toEqual(i);
  });

  it('leaves no tmp files behind and replaces an existing file', () => {
    writeServerInfo(dataDir, info({ port: 1111 }));
    writeServerInfo(dataDir, info({ port: 2222 }));
    expect(readdirSync(dataDir)).toEqual([SERVER_FILE_NAME]);
    expect(readServerInfo(dataDir)?.port).toBe(2222);
  });

  it.runIf(POSIX)('file mode is 0600 and a new data dir is 0700 (POSIX)', () => {
    const oldMask = process.umask(0o000);
    try {
      writeServerInfo(dataDir, info());
    } finally {
      process.umask(oldMask);
    }
    expect(statSync(serverInfoPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['port 0', { port: 0 }],
    ['port 70000', { port: 70000 }],
    ['short token', { token: 'abc' }],
    ['uppercase token', { token: 'AB'.repeat(32) }],
    ['pid 0', { pid: 0 }],
    ['fractional port', { port: 1.5 }],
  ])('throws on invalid info (%s) and writes nothing', (_name, over) => {
    expect(() => writeServerInfo(dataDir, info(over as Partial<ServerInfo>))).toThrow(TypeError);
    expect(existsSync(serverInfoPath(dataDir))).toBe(false);
  });

  it('a failed write cleans up its tmp file and leaves the target alone', () => {
    // A non-empty directory named server.json makes the final rename fail on every platform.
    mkdirSync(join(serverInfoPath(dataDir), 'child'), { recursive: true });
    expect(() => writeServerInfo(dataDir, info())).toThrow();
    expect(readdirSync(dataDir)).toEqual([SERVER_FILE_NAME]);
    expect(statSync(serverInfoPath(dataDir)).isDirectory()).toBe(true);
  });
});

describe('readServerInfo', () => {
  it('returns null for a missing file, invalid JSON or a bad shape', () => {
    expect(readServerInfo(dataDir)).toBeNull();
    writeServerInfo(dataDir, info());
    const file = serverInfoPath(dataDir);
    for (const bad of [
      '{',
      '[]',
      'null',
      '{"version":1}',
      JSON.stringify({ ...info(), version: 2 }),
    ]) {
      writeFileSync(file, bad);
      expect(readServerInfo(dataDir)).toBeNull();
    }
  });
});

describe('removeServerInfo', () => {
  it('removes the file only when the pid matches', () => {
    writeServerInfo(dataDir, info({ pid: 4242 }));
    expect(removeServerInfo(dataDir, 1)).toBe(false);
    expect(existsSync(serverInfoPath(dataDir))).toBe(true);
    expect(removeServerInfo(dataDir, 4242)).toBe(true);
    expect(existsSync(serverInfoPath(dataDir))).toBe(false);
  });

  it('never throws when the file or dir is missing or invalid', () => {
    expect(removeServerInfo(dataDir, process.pid)).toBe(false);
    writeServerInfo(dataDir, info());
    writeFileSync(serverInfoPath(dataDir), 'garbage');
    expect(removeServerInfo(dataDir, process.pid)).toBe(false);
    expect(existsSync(serverInfoPath(dataDir))).toBe(true);
  });
});
