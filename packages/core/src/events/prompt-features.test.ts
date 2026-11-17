import { describe, expect, it } from 'vitest';
import { VARIANTS, DOC_EXAMPLES } from '../fixtures/index.js';
import { promptFeatures } from './prompt-features.js';

const SAFE_FIRST_WORD = /^[a-z][a-z'-]{0,23}$|^\/[a-z0-9:_-]{1,32}$/;

describe('promptFeatures', () => {
  it('returns zeros for an empty prompt', () => {
    expect(promptFeatures('')).toEqual({
      length: 0,
      wordCount: 0,
      lineCount: 0,
      pastedBlocks: 0,
      codeFences: 0,
      isSlashCommand: false,
      firstWord: null,
    });
  });

  it('handles a whitespace-only prompt', () => {
    expect(promptFeatures('   \n  ')).toMatchObject({
      length: 6,
      wordCount: 0,
      lineCount: 2,
      firstWord: null,
    });
  });

  it('summarizes the doc UserPromptSubmit example', () => {
    const prompt = DOC_EXAMPLES.UserPromptSubmit['prompt'] as string;
    expect(promptFeatures(prompt)).toEqual({
      length: prompt.length,
      wordCount: 10,
      lineCount: 1,
      pastedBlocks: 0,
      codeFences: 0,
      isSlashCommand: false,
      firstWord: 'write',
    });
  });

  it('counts the pasted block and the code fences in the pasted variant', () => {
    const prompt = VARIANTS.userPromptSubmitPasted['prompt'] as string;
    expect(promptFeatures(prompt)).toMatchObject({
      lineCount: 6,
      pastedBlocks: 1,
      codeFences: 2,
      firstWord: 'fix',
    });
  });

  it('recognizes the slash-command variant', () => {
    const prompt = VARIANTS.userPromptSubmitSlashCommand['prompt'] as string;
    expect(promptFeatures(prompt)).toMatchObject({
      isSlashCommand: true,
      firstWord: '/review',
      wordCount: 2,
    });
  });

  describe('length', () => {
    it('is measured in code points', () => {
      expect(promptFeatures('😀😀 ok').length).toBe(5);
      expect(promptFeatures('中文').length).toBe(2);
    });
  });

  describe('wordCount', () => {
    it('splits on any whitespace run', () => {
      expect(promptFeatures('a  b\tc\n\nd').wordCount).toBe(4);
      expect(promptFeatures('  leading and trailing  ').wordCount).toBe(3);
    });
  });

  describe('lineCount', () => {
    it('counts LF, CRLF and CR line breaks', () => {
      expect(promptFeatures('one').lineCount).toBe(1);
      expect(promptFeatures('a\nb').lineCount).toBe(2);
      expect(promptFeatures('a\r\nb\r\nc').lineCount).toBe(3);
      expect(promptFeatures('a\rb').lineCount).toBe(2);
      expect(promptFeatures('a\n').lineCount).toBe(2);
    });
  });

  describe('pastedBlocks', () => {
    it('counts only whole-line markers', () => {
      const p = [
        '<pasted_content id="1">',
        'x',
        '<pasted_content id="abc-2">',
        'inline <pasted_content id="3"> does not count',
        ' <pasted_content id="4">',
        '<pasted_content id=4>',
      ].join('\n');
      expect(promptFeatures(p).pastedBlocks).toBe(2);
    });

    it('accepts CRLF line endings around a marker', () => {
      expect(promptFeatures('a\r\n<pasted_content id="1">\r\nb').pastedBlocks).toBe(1);
    });
  });

  describe('codeFences', () => {
    it('counts lines starting with ``` (indent allowed)', () => {
      expect(promptFeatures('```ts\ncode\n```').codeFences).toBe(2);
      expect(promptFeatures('  ```\nx').codeFences).toBe(1);
      expect(promptFeatures('inline ``` fence').codeFences).toBe(0);
      expect(promptFeatures('``not a fence').codeFences).toBe(0);
    });
  });

  describe('isSlashCommand', () => {
    it('is true only when the prompt starts with /', () => {
      expect(promptFeatures('/help').isSlashCommand).toBe(true);
      expect(promptFeatures(' /help').isSlashCommand).toBe(false);
      expect(promptFeatures('use /help').isSlashCommand).toBe(false);
    });
  });

  describe('firstWord', () => {
    it.each([
      ['Fix the bug', 'fix'],
      ['REFACTOR everything', 'refactor'],
      ['hello, world', 'hello'],
      ['Why?', 'why'],
      ['done...', 'done'],
      ["don't break it", "don't"],
      ['re-run tests', 're-run'],
      ['   indented start', 'indented'],
      ['\n\nnewline start', 'newline'],
      ['/review src', '/review'],
      ['/Review src', '/review'],
      ['/mcp__server__tool arg', '/mcp__server__tool'],
      ['/plugin:command', '/plugin:command'],
      ['/review, please', '/review'],
      ['a'.repeat(24), 'a'.repeat(24)],
    ])('%j → %j', (prompt, expected) => {
      expect(promptFeatures(prompt).firstWord).toBe(expected);
    });

    it.each([
      ['AWT_SENTINEL_7f3a9c is the first word'],
      ['awt_sentinel_7f3a9c'],
      ['sk-ant-api03-abcdef0123 leaked'],
      ['ghp_0123456789abcdef'],
      ['/Users/alice/secret.txt please read'],
      ['C:\\Users\\alice\\secret.txt'],
      ['./script.sh'],
      ['https://example.com/x'],
      ['user@example.com'],
      ['123 go'],
      ['2fa setup'],
      ['naïve approach'],
      ['日本語 prompt'],
      ['...'],
      ['/'],
      ['/' + 'a'.repeat(33)],
      ['a'.repeat(25)],
      ['-flag'],
      ['😀 emoji'],
    ])('%j → null', (prompt) => {
      expect(promptFeatures(prompt).firstWord).toBeNull();
    });

    it('is always null or a safe token (property over varied inputs)', () => {
      const pieces = [
        'Fix',
        'AWT_SENTINEL_1',
        '/cmd',
        '/a/b',
        'x'.repeat(40),
        "it's",
        'a.b.c',
        '¿qué?',
        'ÄBC',
        '',
        ' ',
        '\t',
        '\n',
        '!',
        '😀',
        '--',
        'ok,',
      ];
      for (const a of pieces) {
        for (const b of pieces) {
          const fw = promptFeatures(a + b + ' tail').firstWord;
          if (fw !== null) expect(fw).toMatch(SAFE_FIRST_WORD);
        }
      }
    });
  });

  it('keeps a slash-command name verbatim (lowercased) by design (D1.17)', () => {
    // Slash-command names are command identifiers, not prompt content; the regex allows _ and digits.
    expect(promptFeatures('/my_cmd2 run').firstWord).toBe('/my_cmd2');
  });

  it('never returns any other string than firstWord (no text leaks through other fields)', () => {
    const f = promptFeatures('secretword and more text\n<pasted_content id="1">');
    for (const [k, v] of Object.entries(f)) {
      if (k !== 'firstWord') expect(typeof v === 'number' || typeof v === 'boolean').toBe(true);
    }
  });
});
