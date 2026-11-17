// Content-free prompt features (plan 01 §3.6, D1.17). The raw prompt never leaves this function.
import type { PromptFeatures } from './types.js';
import { codePointLength } from './util.js';

const LINE_BREAK = /\r\n|\r|\n/;
const PASTED_MARKER = /^<pasted_content id="[^"]*">$/;
const CODE_FENCE = /^\s*```/;
const SAFE_WORD = /^[a-z][a-z'-]{0,23}$/;
const SAFE_SLASH = /^\/[a-z0-9:_-]{1,32}$/;
const TRAILING_PUNCT = /\p{P}+$/u;

/** Derives content-free features (length, counts, safe first word) from a raw prompt. */
export function promptFeatures(prompt: string): PromptFeatures {
  const lines = prompt.length === 0 ? [] : prompt.split(LINE_BREAK);
  let pastedBlocks = 0;
  let codeFences = 0;
  for (const line of lines) {
    if (PASTED_MARKER.test(line)) pastedBlocks++;
    if (CODE_FENCE.test(line)) codeFences++;
  }
  const tokens = prompt.split(/\s+/).filter((t) => t.length > 0);
  return {
    length: codePointLength(prompt),
    wordCount: tokens.length,
    lineCount: lines.length,
    pastedBlocks,
    codeFences,
    isSlashCommand: prompt.startsWith('/'),
    firstWord: safeFirstWord(tokens[0]),
  };
}

/** Lowercases and strips trailing punctuation; keeps the result only if it is a plain word or slash command. */
function safeFirstWord(token: string | undefined): string | null {
  if (token === undefined) return null;
  const lowered = token.toLowerCase();
  // A slash command keeps its own characters; only plain words lose trailing punctuation.
  if (SAFE_SLASH.test(lowered)) return lowered;
  const stripped = lowered.replace(TRAILING_PUNCT, '');
  if (SAFE_WORD.test(stripped) || SAFE_SLASH.test(stripped)) return stripped;
  return null;
}
