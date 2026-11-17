// Hard rule 2: the server is reachable on 127.0.0.1 only (plan 01 §6.1 "Bind").
import { connect, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateToken } from './auth';
import { startEventServer, type EventServer } from './http';

let server: EventServer;

beforeAll(async () => {
  server = await startEventServer({
    token: generateToken(),
    onEvent: () => {},
    keepRawPrompt: () => false,
  });
});
afterAll(async () => {
  await server.close();
});

type Attempt = { connected: boolean; code: string | undefined };

/** Tries a TCP connect; a timeout counts as "not connected". */
function tryConnect(host: string, port: number, timeoutMs = 2000): Promise<Attempt> {
  return new Promise((res) => {
    const sock = connect({ host, port });
    const done = (a: Attempt): void => {
      sock.destroy();
      res(a);
    };
    sock.setTimeout(timeoutMs, () => done({ connected: false, code: 'TIMEOUT' }));
    sock.once('connect', () => done({ connected: true, code: undefined }));
    sock.once('error', (err: NodeJS.ErrnoException) => done({ connected: false, code: err.code }));
  });
}

/** Every non-internal interface address, with the IPv6 zone where one is needed. */
function externalAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      if (a.family === 'IPv6' && a.address.toLowerCase().startsWith('fe80:')) {
        out.push(`${a.address}%${a.scopeid ?? 0}`);
      } else {
        out.push(a.address);
      }
    }
  }
  return out;
}

describe('bind', () => {
  it('listens on 127.0.0.1 exactly', () => {
    expect(server.address).toBe('127.0.0.1');
  });

  it('accepts connections on 127.0.0.1 (control)', async () => {
    expect((await tryConnect('127.0.0.1', server.port)).connected).toBe(true);
  });

  it('refuses ::1', async () => {
    const a = await tryConnect('::1', server.port);
    expect(a.connected).toBe(false);
  });

  it('refuses every non-internal interface address', async (ctx) => {
    const addrs = externalAddresses();
    if (addrs.length === 0) {
      console.warn('bind.test: no non-internal network interfaces; external bind check skipped');
      ctx.skip();
      return;
    }
    const results = await Promise.all(
      addrs.map(async (host) => ({ host, ...(await tryConnect(host, server.port)) })),
    );
    for (const r of results) {
      expect(r, `connect to ${r.host}`).toMatchObject({ connected: false });
    }
  });

  it('rejects when the port is taken (exclusive, no fallback port)', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen({ host: '127.0.0.1', port: 0 }, r));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      await expect(
        startEventServer({
          token: generateToken(),
          port,
          onEvent: () => {},
          keepRawPrompt: () => false,
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('honours an explicit port', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen({ host: '127.0.0.1', port: 0 }, r));
    const addr = probe.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    await new Promise<void>((r) => probe.close(() => r()));
    const s = await startEventServer({
      token: generateToken(),
      port,
      onEvent: () => {},
      keepRawPrompt: () => false,
    });
    try {
      expect(s.port).toBe(port);
      expect(s.address).toBe('127.0.0.1');
    } finally {
      await s.close();
    }
  });
});
