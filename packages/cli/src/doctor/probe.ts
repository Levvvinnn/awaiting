// Doctor's loopback HTTP probe: the only file in packages/cli allowed to use node:http
// (eslint override, plan 01 §4). Talks only to 127.0.0.1; never sends anything else.
import http from 'node:http';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

export type ProbeResponse =
  { ok: true; status: number; body: string } | { ok: false; error: string };

/** GET `http://127.0.0.1:<port><urlPath>` with the Bearer token; never rejects. */
export function getLoopback(
  port: number,
  urlPath: string,
  token: string,
  timeoutMs: number,
): Promise<ProbeResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ProbeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = http.request({
      host: LOOPBACK,
      port,
      method: 'GET',
      path: urlPath,
      agent: false,
      headers: { authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, error: `no response within ${timeoutMs} ms` });
    }, timeoutMs);
    req.on('error', (err) => done({ ok: false, error: err.message }));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      res.on('error', (err) => done({ ok: false, error: err.message }));
      res.on('end', () =>
        done({
          ok: true,
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.end();
  });
}
