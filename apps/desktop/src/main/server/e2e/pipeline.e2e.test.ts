// M1 pipeline end-to-end (plan 01 §6.1): a 6-event turn sent through the real hook script →
// loopback server → Ingestor (periodic tick, 250 ms reorder window) → file SQLite DB. Checks the
// stored `turns` row and that the debug `onChange` stream saw the event and turn rows.
import { randomBytes } from 'node:crypto';
import { DOC_EXAMPLES, cloneFixture } from '@awaiting/core/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { isDebugUpdate, type DebugEventRow, type DebugTurnRow } from '../../../shared/debug-types';
import { startHarness, waitUntil, type Harness } from './harness';

let h: Harness | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
});

interface TurnDbRow {
  session_id: string;
  seq: number;
  status: string;
  end_reason: string | null;
  started_at: number;
  ended_at: number | null;
  event_count: number;
  tool_count: number;
  reopened_count: number;
  prompt_length: number | null;
  prompt_text: string | null;
}

interface EventDbRow {
  event_name: string;
  received_at: number;
  turn_seq: number | null;
  tool_name: string | null;
  tool_use_id: string | null;
}

describe('pipeline: hook → server → ingestor → DB', () => {
  it('a 6-event turn ends as done/stop and onChange sees its event and turn rows', async () => {
    const sid = `e2e-pipeline-${randomBytes(4).toString('hex')}`;
    const harness = await startHarness({ ticking: true });
    h = harness;
    const t0 = Date.now();

    const prompt = 'Write a function to calculate the factorial of a number';
    const payloads = [
      cloneFixture(DOC_EXAMPLES.SessionStart, { session_id: sid }),
      cloneFixture(DOC_EXAMPLES.UserPromptSubmit, { session_id: sid, prompt }),
      cloneFixture(DOC_EXAMPLES.PreToolUse, { session_id: sid, tool_use_id: 'toolu_e2e_p1' }),
      cloneFixture(DOC_EXAMPLES.PostToolUse, {
        session_id: sid,
        tool_name: 'Bash',
        tool_input: { command: 'npm test', description: 'Run test suite' },
        tool_response: { stdout: 'ok', exitCode: 0 },
        tool_use_id: 'toolu_e2e_p1',
      }),
      cloneFixture(DOC_EXAMPLES.Stop, { session_id: sid, stop_hook_active: false }),
      cloneFixture(DOC_EXAMPLES.SessionEnd, { session_id: sid }),
    ];
    const names = payloads.map((p) => p['hook_event_name']);

    for (const p of payloads) {
      const run = await h.send(p);
      expect(run, `hook run for ${String(p['hook_event_name'])}`).toEqual({
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
      });
    }
    const t1 = Date.now();

    // Applied by the app's own periodic tick once the 250 ms reorder window has passed.
    await waitUntil(
      () => harness.ingestor.stats().applied >= payloads.length,
      'ingestor to apply 6 events',
    );
    expect(h.ingestor.pendingCount).toBe(0);
    expect(h.errors).toEqual([]);
    expect(h.ingestor.stats()).toMatchObject({ applied: 6, failed: 0 });

    // The hook stamped received_at itself (within the send window) and dropped tool_response.
    expect(h.received.map((e) => e.eventName)).toEqual(names);
    for (const e of h.received) {
      expect(e.sessionId).toBe(sid);
      expect(e.receivedAt).toBeGreaterThanOrEqual(t0);
      expect(e.receivedAt).toBeLessThanOrEqual(t1);
    }
    expect(JSON.stringify(h.received[3])).not.toContain('exitCode');

    // DB: one closed turn, every event stored in order.
    const turns = h.db
      .prepare<[string], TurnDbRow>(
        `SELECT session_id, seq, status, end_reason, started_at, ended_at, event_count, tool_count,
                reopened_count, prompt_length, prompt_text
         FROM turns WHERE session_id = ? ORDER BY seq`,
      )
      .all(sid);
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    if (turn === undefined) throw new Error('no turn row');
    expect(turn).toMatchObject({
      seq: 1,
      status: 'done',
      end_reason: 'stop',
      tool_count: 1,
      reopened_count: 0,
      prompt_length: [...prompt].length,
      prompt_text: null,
    });
    const byName = new Map(h.received.map((e) => [e.eventName, e]));
    expect(turn.started_at).toBe(byName.get('UserPromptSubmit')?.receivedAt);
    expect(turn.ended_at).toBe(byName.get('Stop')?.receivedAt);

    const events = h.db
      .prepare<[string], EventDbRow>(
        `SELECT e.event_name, e.received_at, t.seq AS turn_seq, e.tool_name, e.tool_use_id
         FROM events e LEFT JOIN turns t ON t.id = e.turn_id
         WHERE e.session_id = ? ORDER BY e.id`,
      )
      .all(sid);
    expect(events.map((e) => e.event_name)).toEqual(names);
    expect(events.map((e) => e.received_at)).toEqual(h.received.map((e) => e.receivedAt));
    // UserPromptSubmit … Stop belong to turn 1.
    expect(events.slice(1, 5).map((e) => e.turn_seq)).toEqual([1, 1, 1, 1]);
    expect(events[2]).toMatchObject({ tool_name: 'Bash', tool_use_id: 'toolu_e2e_p1' });
    expect(turn.event_count).toBe(events.filter((e) => e.turn_seq === 1).length);

    const session = h.db
      .prepare<
        [string],
        { ended_at: number | null; end_reason: string | null; start_source: string | null }
      >('SELECT ended_at, end_reason, start_source FROM sessions WHERE session_id = ?')
      .get(sid);
    expect(session).toEqual({
      ended_at: byName.get('SessionEnd')?.receivedAt,
      end_reason: 'other',
      start_source: 'startup',
    });

    // onChange: every update is a valid DebugUpdate; it carried all 6 event rows in order and the
    // turn's rows, ending with the closed state.
    expect(h.updates.length).toBeGreaterThan(0);
    for (const u of h.updates) expect(isDebugUpdate(u)).toBe(true);
    const seenEvents: DebugEventRow[] = h.updates.flatMap((u) => u.events);
    const seenTurns: DebugTurnRow[] = h.updates.flatMap((u) => u.turns);
    expect(seenEvents.map((e) => e.eventName)).toEqual(names);
    expect(seenEvents.every((e) => e.sessionId === sid)).toBe(true);
    expect(seenEvents.find((e) => e.eventName === 'PreToolUse')).toMatchObject({
      toolName: 'Bash',
      turnSeq: 1,
    });
    const turnRows = seenTurns.filter((t) => t.sessionId === sid && t.seq === 1);
    expect(turnRows.length).toBeGreaterThan(0);
    expect(turnRows.at(-1)).toEqual({
      sessionId: sid,
      seq: 1,
      status: 'done',
      startedAt: turn.started_at,
      endedAt: turn.ended_at,
      endReason: 'stop',
      eventCount: turn.event_count,
    });
  }, 30_000);
});
