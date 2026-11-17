// Test stand-in for the awaiting app's loopback server (plan 01 §3.5 routes used by doctor):
// GET /health, GET /doctor/ping/<nonce>, POST /events (records AwaitingDoctorPing nonces).
// Binds 127.0.0.1:0 only. Lives in test/, not in doctor's code (doctor's HTTP is in src/doctor/probe.ts).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type FakeApp = {
  port: number;
  token: string;
  events: unknown[];
  pings: Set<string>;
  writeServerJson(dataDir: string, pid?: number): void;
  close(): Promise<void>;
};

export async function startFakeApp(
  opts: { health?: 'ok' | 'error'; recordPings?: boolean } = {},
): Promise<FakeApp> {
  const token = randomBytes(32).toString('hex');
  const events: unknown[] = [];
  const pings = new Set<string>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/health') {
        if (opts.health === 'error') return void res.writeHead(500).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ app: 'awaiting', ok: true, hookVersion: 1 }));
      }
      const ping = /^\/doctor\/ping\/([0-9a-f]{32})$/.exec(url);
      if (req.method === 'GET' && ping) {
        return void res.writeHead(pings.has(ping[1] ?? '') ? 200 : 404).end();
      }
      if (req.method === 'POST' && url === '/events') {
        let body: { hook_event_name?: unknown; nonce?: unknown } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
        } catch {
          return void res.writeHead(400).end();
        }
        events.push(body);
        if (
          opts.recordPings !== false &&
          body.hook_event_name === 'AwaitingDoctorPing' &&
          typeof body.nonce === 'string'
        ) {
          pings.add(body.nonce);
        }
        return void res.writeHead(202).end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const addr = server.address();
  const port = addr !== null && typeof addr === 'object' ? addr.port : 0;
  return {
    port,
    token,
    events,
    pings,
    writeServerJson(dataDir, pid = process.pid) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'server.json'),
        JSON.stringify({ version: 1, port, token, pid, startedAt: Date.now() }),
      );
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
