// Reading and writing settings.json (plan 01 §3.10 Read/Write). Formatting is preserved where
// JSON allows: BOM, EOL, indent and trailing newline. Key order is preserved by JSON.parse.
import fs from 'node:fs';
import path from 'node:path';
import { createBackup } from './backup';
import { isPlainObject, type JsonObject } from './merge';

export type SettingsFormat = {
  bom: boolean;
  eol: '\n' | '\r\n';
  indent: string | number;
  trailingNewline: boolean;
};

export type ReadOk = {
  kind: 'ok';
  value: JsonObject;
  raw: Buffer;
  mtimeMs: number;
} & SettingsFormat;

export type ReadResult = { kind: 'missing' } | ReadOk | { kind: 'malformed'; error: string };

export const DEFAULT_FORMAT: SettingsFormat = {
  bom: false,
  eol: '\n',
  indent: 2,
  trailingNewline: true,
};

/** Indent of the first indented line: a tab, a run of spaces (count), or 2 by default. */
export function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  if (m === null) return 2;
  const ws = m[1] ?? '';
  if (ws.startsWith('\t')) return '\t';
  return Math.min(Math.max(ws.length, 1), 10);
}

/** Checks the shape we rely on: object top level, object `hooks`, array per event. */
export function validateShape(value: unknown): string | null {
  if (!isPlainObject(value)) return 'top level is not a JSON object';
  if (!('hooks' in value)) return null;
  const hooks = value['hooks'];
  if (!isPlainObject(hooks)) return '"hooks" is not a JSON object';
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return `"hooks.${event}" is not an array`;
  }
  return null;
}

/** Parses settings text. Exported for tests. */
export function parseSettings(
  raw: Buffer,
):
  { kind: 'ok'; value: JsonObject; format: SettingsFormat } | { kind: 'malformed'; error: string } {
  let text = raw.toString('utf8');
  const bom = text.startsWith('\uFEFF');
  if (bom) text = text.slice(1);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { kind: 'malformed', error: `invalid JSON: ${(err as Error).message}` };
  }
  const shapeError = validateShape(value);
  if (shapeError !== null) return { kind: 'malformed', error: shapeError };
  return {
    kind: 'ok',
    value: value as JsonObject,
    format: {
      bom,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
      indent: detectIndent(text),
      trailingNewline: /\r?\n$/.test(text),
    },
  };
}

export function readSettings(file: string): ReadResult {
  let raw: Buffer;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(file);
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'malformed', error: `cannot read: ${(err as Error).message}` };
  }
  const parsed = parseSettings(raw);
  if (parsed.kind === 'malformed') return parsed;
  return { kind: 'ok', value: parsed.value, raw, mtimeMs, ...parsed.format };
}

export function serializeSettings(value: JsonObject, format: SettingsFormat): string {
  // JSON.stringify escapes newlines inside strings, so every "\n" here is structural.
  let text = JSON.stringify(value, null, format.indent);
  if (format.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (format.trailingNewline) text += format.eol;
  return (format.bom ? '\uFEFF' : '') + text;
}

export class SettingsChangedError extends Error {
  constructor(file: string) {
    super(`${file} changed during the operation; nothing was written, please retry`);
    this.name = 'SettingsChangedError';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes `data` to `file` via `<file>.awaiting-tmp-<pid>`, fsync and rename. */
export function atomicWrite(file: string, data: string | Buffer, mode?: number): void {
  const tmp = `${file}.awaiting-tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 3 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
      throw err;
    }
  }
}

/**
 * Writes new settings text. With `original` (the file existed): re-reads and aborts if the bytes
 * changed, then backs up the raw bytes, then writes atomically. Without it (missing file): creates
 * the parent dir and aborts if a file appeared meanwhile. Returns the backup path, if any.
 */
export function writeSettings(
  file: string,
  text: string,
  original: { raw: Buffer } | null,
  now: number,
): { backup: string | null } {
  let backup: string | null = null;
  if (original !== null) {
    let current: Buffer;
    try {
      current = fs.readFileSync(file);
    } catch {
      throw new SettingsChangedError(file);
    }
    if (!current.equals(original.raw)) throw new SettingsChangedError(file);
    backup = createBackup(file, now);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) throw new SettingsChangedError(file);
  }
  atomicWrite(file, text);
  return { backup };
}
