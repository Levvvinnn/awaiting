// Small pure helpers shared by the event modules (internal; not exported from the package).

/** True for a non-null, non-array object whose prototype is `Object.prototype` or `null` (a JSON object). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Number of Unicode code points in `s` (lone surrogates count as one). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // A high surrogate followed by a low surrogate is one code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** `s` truncated to at most `max` code points, never splitting a surrogate pair. */
export function capString(s: string, max: number): string {
  // UTF-16 length is an upper bound on the code-point count, so short strings return as-is.
  if (s.length <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n === max) break;
    out += ch;
    n++;
  }
  return out;
}

/** The text before the first line break (`\n`, `\r\n` or `\r`). */
export function firstLine(s: string): string {
  const idx = s.search(/\r\n|\r|\n/);
  return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Reads an optional field. Absent (`undefined`) and `null` are treated as missing; any other value
 * that fails `check` is reported through `invalid` and treated as missing.
 */
export function readOptional<T>(
  body: Readonly<Record<string, unknown>>,
  key: string,
  check: (v: unknown) => v is T,
  invalid: string[],
): T | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (check(v)) return v;
  invalid.push(key);
  return undefined;
}

/** Type guard for strings. */
export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** Type guard for booleans. */
export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** Type guard for finite, non-negative numbers (durations). */
export function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Type guard for arrays. */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
