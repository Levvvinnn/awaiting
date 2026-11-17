import { describe, expect, it } from 'vitest';
import {
  capString,
  codePointLength,
  firstLine,
  isNonNegativeFinite,
  isPlainObject,
  readOptional,
  isString,
} from './util.js';

describe('isPlainObject', () => {
  it('accepts JSON objects and null-prototype objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('rejects null, arrays, primitives and class instances', () => {
    for (const v of [null, undefined, [], [1], 'x', 1, true, new Date(0), new Map()]) {
      expect(isPlainObject(v)).toBe(false);
    }
  });
});

describe('codePointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('a😀b')).toBe(3);
    expect('a😀b'.length).toBe(4);
  });

  it('counts a lone surrogate as one code point', () => {
    expect(codePointLength('\ud83d')).toBe(1);
    expect(codePointLength('a\ude00')).toBe(2);
  });

  it('agrees with the spread operator on mixed strings', () => {
    for (const s of ['', 'x', '😀😀', 'é́', 'a\ud83db', '中文テキスト', '\n\r\t']) {
      expect(codePointLength(s)).toBe([...s].length);
    }
  });
});

describe('capString', () => {
  it('returns short strings unchanged', () => {
    expect(capString('abc', 3)).toBe('abc');
    expect(capString('', 0)).toBe('');
  });

  it('truncates to max code points', () => {
    expect(capString('abcdef', 3)).toBe('abc');
    expect(capString('abc', 0)).toBe('');
  });

  it('never splits a surrogate pair', () => {
    expect(capString('😀😀😀', 2)).toBe('😀😀');
    expect(capString('a😀', 1)).toBe('a');
  });

  it('result never exceeds max code points (property)', () => {
    const samples = ['😀'.repeat(50), 'x'.repeat(300), 'a😀'.repeat(77), 'é'.repeat(9)];
    for (const s of samples) {
      for (const max of [0, 1, 2, 5, 64, 256]) {
        const out = capString(s, max);
        expect(codePointLength(out)).toBeLessThanOrEqual(max);
        expect(s.startsWith(out)).toBe(true);
      }
    }
  });
});

describe('firstLine', () => {
  it('splits on LF, CRLF and CR', () => {
    expect(firstLine('a\nb')).toBe('a');
    expect(firstLine('a\r\nb')).toBe('a');
    expect(firstLine('a\rb')).toBe('a');
    expect(firstLine('single')).toBe('single');
    expect(firstLine('\nx')).toBe('');
  });
});

describe('readOptional', () => {
  it('treats undefined and null as absent without reporting', () => {
    const invalid: string[] = [];
    expect(readOptional({ a: null }, 'a', isString, invalid)).toBeUndefined();
    expect(readOptional({}, 'a', isString, invalid)).toBeUndefined();
    expect(invalid).toEqual([]);
  });

  it('reports a wrong type and returns undefined', () => {
    const invalid: string[] = [];
    expect(readOptional({ a: 5 }, 'a', isString, invalid)).toBeUndefined();
    expect(invalid).toEqual(['a']);
  });

  it('returns a valid value', () => {
    const invalid: string[] = [];
    expect(readOptional({ a: 'x' }, 'a', isString, invalid)).toBe('x');
    expect(invalid).toEqual([]);
  });
});

describe('isNonNegativeFinite', () => {
  it('accepts 0 and positive finite numbers only', () => {
    expect(isNonNegativeFinite(0)).toBe(true);
    expect(isNonNegativeFinite(12.5)).toBe(true);
    for (const v of [-1, Number.NaN, Infinity, -Infinity, '1', null]) {
      expect(isNonNegativeFinite(v)).toBe(false);
    }
  });
});
