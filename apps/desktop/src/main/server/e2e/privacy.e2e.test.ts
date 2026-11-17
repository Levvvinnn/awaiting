// H3 acceptance test (plan 01 §6.1, §7 rule 2): raw prompt text and other free text never reach
// disk by default. Every event goes through the real hook script → real loopback server →
// Ingestor → file SQLite DB in a temp AWAITING_HOME. After the DB is closed (WAL checkpointed)
// every file in the data dir is scanned for the sentinel as UTF-8, UTF-16LE and case-insensitively.
// The control case turns on `privacy.storeRawPrompt` and finds a fresh sentinel, proving the probe.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DOC_EXAMPLES, cloneFixture, type HookPayloadFixture } from '@awaiting/core/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../../store/open';
import { findInFiles, listFilesRecursive, startHarness, waitUntil, type Harness } from './harness';

const newSentinel = (): string => `AWT_SENTINEL_${randomBytes(16).toString('hex')}`;
const hexOf = (sentinel: string): string => sentinel.slice('AWT_SENTINEL_'.length);

let h: Harness | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
});

function payload(
  fixture: HookPayloadFixture,
  sessionId: string,
  over: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return cloneFixture(fixture, { session_id: sessionId, ...over });
}

/** Sends each payload through the real hook in order; every run must exit 0 with no output. */
async function sendAll(
  harness: Harness,
  payloads: readonly Record<string, unknown>[],
): Promise<void> {
  for (const p of payloads) {
    const run = await harness.send(p);
    expect(run, `hook run for ${String(p['hook_event_name'])}`).toEqual({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    });
  }
  await waitUntil(() => harness.received.length >= payloads.length, 'server to receive all events');
  expect(harness.received.map((e) => e.eventName)).toEqual(
    payloads.map((p) => p['hook_event_name']),
  );
}

interface TurnTextRow {
  seq: number;
  status: string;
  prompt_length: number | null;
  prompt_first_word: string | null;
  prompt_pasted_blocks: number | null;
  prompt_text: string | null;
}

/** Reopens the closed DB read-only-in-spirit (SELECT only) and returns its turns. */
function readTurns(dbFile: string): TurnTextRow[] {
  const db = openStore(dbFile);
  try {
    return db
      .prepare<[], TurnTextRow>(
        `SELECT seq, status, prompt_length, prompt_first_word, prompt_pasted_blocks, prompt_text
         FROM turns ORDER BY seq`,
      )
      .all();
  } finally {
    db.close();
  }
}

describe('H3: no raw text on disk by default (hook → server → ingestor → file DB)', () => {
  it('a sentinel in prompts, tool_input.content and last_assistant_message never reaches any file', async () => {
    const S = newSentinel();
    const sid = `e2e-privacy-${randomBytes(4).toString('hex')}`;
    h = await startHarness();
    expect(h.repo.getSetting('privacy.storeRawPrompt')).toBe(false);

    const prompts = [
      `${S} please refactor the parser`,
      `Please look at ${S} and explain what it means`,
      `Fix this stack trace:\n<pasted_content id="1">\nTypeError: ${S} is undefined\n</pasted_content>\nthanks`,
    ];
    const writeInput = { file_path: '/Users/alice/my-project/notes.txt', content: `secret ${S}` };
    const payloads: Record<string, unknown>[] = [
      payload(DOC_EXAMPLES.SessionStart, sid),
      // Turn 1: sentinel as the first word, plus a Write whose content carries it.
      payload(DOC_EXAMPLES.UserPromptSubmit, sid, { prompt: prompts[0] }),
      payload(DOC_EXAMPLES.PreToolUse, sid, {
        tool_name: 'Write',
        tool_input: writeInput,
        tool_use_id: 'toolu_e2e_1',
      }),
      payload(DOC_EXAMPLES.PostToolUse, sid, {
        tool_input: writeInput,
        tool_response: { filePath: writeInput.file_path, success: true, echoed: S },
        tool_use_id: 'toolu_e2e_1',
      }),
      payload(DOC_EXAMPLES.Stop, sid, {
        stop_hook_active: false,
        last_assistant_message: `Done. I wrote ${S} to the file.`,
      }),
      // Turn 2: sentinel mid-text.
      payload(DOC_EXAMPLES.UserPromptSubmit, sid, { prompt: prompts[1] }),
      payload(DOC_EXAMPLES.Stop, sid, {
        stop_hook_active: false,
        last_assistant_message: S,
      }),
      // Turn 3: sentinel inside a <pasted_content> block.
      payload(DOC_EXAMPLES.UserPromptSubmit, sid, { prompt: prompts[2] }),
      payload(DOC_EXAMPLES.Stop, sid, {
        stop_hook_active: false,
        last_assistant_message: `${S.toLowerCase()} fixed`,
      }),
      payload(DOC_EXAMPLES.SessionEnd, sid),
    ];
    await sendAll(h, payloads);

    // Features arrived, raw text did not (the parser dropped it before the queue).
    const submits = h.received.filter((e) => e.eventName === 'UserPromptSubmit');
    expect(submits).toHaveLength(3);
    for (const [i, e] of submits.entries()) {
      expect(e.promptText).toBeNull();
      expect(e.prompt?.length).toBe([...(prompts[i] ?? '')].length);
      expect(JSON.stringify(e)).not.toContain(hexOf(S));
    }
    for (const e of h.received) expect(JSON.stringify(e).toLowerCase()).not.toContain(hexOf(S));

    await h.shutdown();
    expect(h.errors).toEqual([]);
    expect(h.ingestor.stats()).toMatchObject({ applied: payloads.length, failed: 0 });

    // Closing checkpointed the WAL into the main file; server.json was removed on close.
    expect(existsSync(h.dbFile)).toBe(true);
    expect(existsSync(`${h.dbFile}-wal`)).toBe(false);
    const files = listFilesRecursive(h.dataDir);
    expect(files.length).toBeGreaterThan(0);

    // The probe reads real content: a known column value is visible in the scanned bytes.
    expect(findInFiles(h.dataDir, 'UserPromptSubmit').length).toBeGreaterThan(0);
    expect(findInFiles(h.dataDir, sid).length).toBeGreaterThan(0);

    expect(findInFiles(h.dataDir, S)).toEqual([]);
    expect(findInFiles(h.dataDir, hexOf(S))).toEqual([]);

    // The turns exist with features only.
    const turns = readTurns(h.dbFile);
    expect(turns).toHaveLength(3);
    for (const [i, t] of turns.entries()) {
      expect(t.status).toBe('done');
      expect(t.prompt_text).toBeNull();
      expect(t.prompt_first_word ?? '').not.toMatch(/awt|sentinel/i);
      expect(t.prompt_length).toBe([...(prompts[i] ?? '')].length);
    }
    expect(turns[0]?.prompt_first_word).toBeNull();
    expect(turns[1]?.prompt_first_word).toBe('please');
    expect(turns[2]?.prompt_pasted_blocks).toBe(1);
  }, 30_000);

  it('control: with privacy.storeRawPrompt = true a fresh sentinel IS found in turns.prompt_text', async () => {
    const S = newSentinel();
    const other = newSentinel();
    const sid = `e2e-privacy-ctl-${randomBytes(4).toString('hex')}`;
    h = await startHarness({ storeRawPrompt: true });

    const prompt = `Please handle ${S} carefully`;
    await sendAll(h, [
      payload(DOC_EXAMPLES.SessionStart, sid),
      payload(DOC_EXAMPLES.UserPromptSubmit, sid, { prompt }),
      payload(DOC_EXAMPLES.Stop, sid, {
        stop_hook_active: false,
        last_assistant_message: `answer ${other}`,
      }),
    ]);
    expect(h.received[1]?.promptText).toBe(prompt);

    await h.shutdown();
    expect(h.errors).toEqual([]);

    // The same probe finds it on disk, so an empty result above is meaningful.
    const hits = findInFiles(h.dataDir, S);
    expect(hits.map((x) => x.file)).toContain(h.dbFile);
    expect(hits.some((x) => x.how === `utf8:${S}`)).toBe(true);

    const turns = readTurns(h.dbFile);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt_text).toBe(prompt);

    // Opt-in covers the prompt only: assistant text is still never stored.
    expect(findInFiles(h.dataDir, other)).toEqual([]);
  }, 30_000);
});
