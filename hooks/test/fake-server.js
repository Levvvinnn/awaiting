'use strict';
// Stand-in for the awaiting event server, run as a forked child of hook.test.js:
//   fork('fake-server.js', [mode, hangMs])   mode: ok (202) | error (500) | hang (no reply for hangMs)
// It binds 127.0.0.1:0, reports { type: 'listening', port } over IPC and records every request.
// The parent asks for the recorded requests with { type: 'requests', id }; IPC is ordered, so the
// reply includes every request whose response was already sent.

const http = require('node:http');

const mode = process.argv[2] ?? 'ok';
const hangMs = Number(process.argv[3] ?? 5000);

/** @type {{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: string }[]} */
const requests = [];

const server = http.createServer((req, res) => {
  /** @type {Buffer[]} */
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => {});
  res.on('error', () => {});
  req.on('end', () => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (mode === 'hang') {
      setTimeout(() => res.writeHead(202).end(), hangMs).unref();
    } else if (mode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    } else {
      res.writeHead(202).end();
    }
  });
});
server.on('clientError', (_err, socket) => socket.destroy());

process.on('message', (msg) => {
  if (msg && msg.type === 'requests') {
    process.send({ type: 'requests', id: msg.id, requests });
  }
});
process.on('disconnect', () => process.exit(0));

server.listen({ host: '127.0.0.1', port: 0 }, () => {
  const addr = server.address();
  process.send({ type: 'listening', port: addr && typeof addr === 'object' ? addr.port : 0 });
});
