import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAMES, desiredHandler } from '../src/events';
import { parseSettings } from '../src/settings/io';
import {
  isOurs,
  jsonEqual,
  planInstall,
  planUninstall,
  type JsonObject,
} from '../src/settings/merge';
import { afterRoundTrip, expectSameMeaningAndOrder, fixturePath } from './semantic';

const HOOK = '/home/u/.awaiting/hook/awaiting-hook.js';
const opts = { hookPath: HOOK, form: 'exec' as const };

function load(name: string): JsonObject {
  const parsed = parseSettings(fs.readFileSync(fixturePath(name)));
  if (parsed.kind !== 'ok') throw new Error(`fixture ${name} did not parse`);
  return parsed.value;
}

function hooksOf(value: JsonObject): Record<string, { matcher?: string; hooks: unknown[] }[]> {
  return value['hooks'] as Record<string, { matcher?: string; hooks: unknown[] }[]>;
}

function oursCount(value: JsonObject, event: string): number {
  return (hooksOf(value)[event] ?? []).flatMap((g) => g.hooks).filter(isOurs).length;
}

describe('desiredHandler (plan §3.4)', () => {
  it('writes async exec-form handlers on the 11 frequent events', () => {
    expect(desiredHandler('PreToolUse', HOOK, 'exec')).toEqual({
      type: 'command',
      command: 'node',
      args: [HOOK],
      async: true,
      timeout: 5,
    });
  });
  it('keeps Stop/StopFailure sync with timeout 2 and SessionEnd with timeout 1', () => {
    expect(desiredHandler('Stop', HOOK, 'exec')).toEqual({
      type: 'command',
      command: 'node',
      args: [HOOK],
      timeout: 2,
    });
    expect(desiredHandler('StopFailure', HOOK, 'exec').timeout).toBe(2);
    expect(desiredHandler('SessionEnd', HOOK, 'exec')).toEqual({
      type: 'command',
      command: 'node',
      args: [HOOK],
      timeout: 1,
    });
  });
  it('shell form quotes the path with forward slashes and has no args', () => {
    expect(desiredHandler('Stop', 'C:\\Users\\a b\\awaiting-hook.js', 'shell')).toEqual({
      type: 'command',
      command: 'node "C:/Users/a b/awaiting-hook.js"',
      timeout: 2,
    });
  });
});

describe('isOurs (D1.8)', () => {
  it.each([
    [{ type: 'command', command: 'node', args: ['/x/awaiting-hook.js'] }],
    [{ type: 'command', command: 'node', args: ['C:\\x\\AWAITING-HOOK.JS'] }],
    [{ type: 'command', command: 'node "/x y/awaiting-hook.js"' }],
    [{ type: 'command', command: 'awaiting-hook.js' }],
    [{ type: 'command', command: "node '/x/awaiting-hook.js' --flag" }],
  ])('recognizes %j', (h) => expect(isOurs(h)).toBe(true));

  it.each([
    [{ type: 'http', url: 'http://127.0.0.1/awaiting-hook.js' }],
    [{ type: 'command', command: 'node', args: ['/x/not-awaiting-hook.js'] }],
    [{ type: 'command', command: 'node /x/my-awaiting-hook.js' }],
    [{ type: 'command', command: 'node /x/awaiting-hook.json' }],
    [null],
    ['awaiting-hook.js'],
    [{ command: 'node', args: ['/x/awaiting-hook.js'] }],
  ])('ignores %j', (h) => expect(isOurs(h)).toBe(false));
});

describe('planInstall', () => {
  it('on {} adds hooks with one group per event in table order', () => {
    const { value, changes } = planInstall({}, opts);
    expect(Object.keys(hooksOf(value))).toEqual([...HOOK_EVENT_NAMES]);
    for (const e of HOOK_EVENT_NAMES) {
      expect(hooksOf(value)[e]).toEqual([{ hooks: [desiredHandler(e, HOOK, 'exec')] }]);
    }
    expect(changes.every((c) => c.kind === 'added')).toBe(true);
    expect(changes).toHaveLength(14);
  });

  it('does not mutate its input', () => {
    const input = load('unrelated-hooks.json');
    const copy = structuredClone(input);
    planInstall(input, opts);
    expect(input).toEqual(copy);
  });

  it('appends hooks as the last top-level key and keeps other settings in order', () => {
    const input = load('other-settings.json');
    const { value } = planInstall(input, opts);
    expect(Object.keys(value)).toEqual([...Object.keys(input), 'hooks']);
  });

  it('appends our group after unrelated user groups on the same events', () => {
    const input = load('unrelated-hooks.json');
    const { value } = planInstall(input, opts);
    const h = hooksOf(value);
    const before = hooksOf(input);
    // user groups first and untouched, ours last
    expect(h['PreToolUse']?.slice(0, -1)).toEqual(before['PreToolUse']);
    expect(h['PreToolUse']?.at(-1)).toEqual({
      hooks: [desiredHandler('PreToolUse', HOOK, 'exec')],
    });
    expect(h['Stop']?.slice(0, -1)).toEqual(before['Stop']);
    // existing event keys keep their order, new events are appended
    expect(Object.keys(h).slice(0, 4)).toEqual([
      'SessionStart',
      'PreToolUse',
      'Stop',
      'PreCompact',
    ]);
    expect(h['PreCompact']).toEqual(before['PreCompact']);
    expect(Object.keys(value)).toEqual(Object.keys(input));
  });

  it('leaves matcher groups (and pre-existing empty arrays) alone', () => {
    const input = load('matcher-groups.json');
    const { value } = planInstall(input, opts);
    const h = hooksOf(value);
    expect(h['PreToolUse']?.slice(0, 2)).toEqual(hooksOf(input)['PreToolUse']);
    expect(h['Notification']?.slice(0, 2)).toEqual(hooksOf(input)['Notification']);
    expect(h['PostToolUse']).toEqual([{ hooks: [desiredHandler('PostToolUse', HOOK, 'exec')] }]);
  });

  it('is idempotent: a second plan reports only unchanged', () => {
    const first = planInstall(load('matcher-groups.json'), opts).value;
    const second = planInstall(first, opts);
    expect(second.changes.every((c) => c.kind === 'unchanged')).toBe(true);
    expectSameMeaningAndOrder(second.value, first);
  });

  it('treats a key-reordered but equal handler as unchanged', () => {
    const value = planInstall({}, opts).value;
    const stop = hooksOf(value)['Stop']?.[0];
    if (stop === undefined) throw new Error('no Stop group');
    stop.hooks[0] = { timeout: 2, args: [HOOK], command: 'node', type: 'command' };
    const again = planInstall(value, opts);
    expect(again.changes.find((c) => c.event === 'Stop')?.kind).toBe('unchanged');
  });

  it('updates a stale entry in place and removes duplicates', () => {
    const input = load('stale-awaiting-entry.json');
    const { value, changes } = planInstall(input, opts);
    const h = hooksOf(value);
    // PreToolUse: stale handler replaced in its own (second) group, user group untouched
    expect(h['PreToolUse']).toEqual([
      hooksOf(input)['PreToolUse']?.[0],
      { hooks: [desiredHandler('PreToolUse', HOOK, 'exec')] },
    ]);
    // Stop: first ours updated, the second group (only ours) removed
    expect(h['Stop']).toEqual([{ hooks: [desiredHandler('Stop', HOOK, 'exec')] }]);
    expect(changes).toContainEqual({ event: 'PreToolUse', kind: 'updated' });
    expect(changes).toContainEqual({ event: 'Stop', kind: 'updated' });
    expect(changes).toContainEqual({ event: 'Stop', kind: 'deduped' });
    for (const e of HOOK_EVENT_NAMES) expect(oursCount(value, e)).toBe(1);
  });

  it('updates our handler inside a user group in place, keeping its neighbours', () => {
    const input = load('user-handler-in-our-group.json');
    const { value } = planInstall(input, opts);
    const group = hooksOf(value)['UserPromptSubmit']?.[0];
    expect(group?.hooks).toEqual([
      { type: 'command', command: 'log-prompt.sh' },
      desiredHandler('UserPromptSubmit', HOOK, 'exec'),
      { type: 'command', command: 'after.sh' },
    ]);
    expect(hooksOf(value)['UserPromptSubmit']).toHaveLength(1);
    // events outside the 14 are not touched by install
    expect(hooksOf(value)['CustomEvent']).toEqual(hooksOf(input)['CustomEvent']);
  });

  it('switching to shell form updates every entry', () => {
    const exec = planInstall({}, opts).value;
    const shell = planInstall(exec, { hookPath: HOOK, form: 'shell' });
    expect(shell.changes.every((c) => c.kind === 'updated')).toBe(true);
    expect(hooksOf(shell.value)['Stop']?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: `node "${HOOK}"`,
      timeout: 2,
    });
  });
});

describe('planUninstall', () => {
  it.each([
    'empty-object.json',
    'unrelated-hooks.json',
    'matcher-groups.json',
    'other-settings.json',
  ])('install then uninstall restores %s (values and key order)', (name) => {
    const original = load(name);
    const installed = planInstall(original, opts).value;
    const { value, changes } = planUninstall(installed);
    expectSameMeaningAndOrder(value, afterRoundTrip(original));
    expect(changes.length).toBeGreaterThan(0);
  });

  it('removes only our handler from a user group and keeps the group', () => {
    const input = load('user-handler-in-our-group.json');
    const { value, changes } = planUninstall(input);
    expect(hooksOf(value)['UserPromptSubmit']).toEqual([
      {
        hooks: [
          { type: 'command', command: 'log-prompt.sh' },
          { type: 'command', command: 'after.sh' },
        ],
      },
    ]);
    // every hooks key is scanned, not only the 14
    expect(hooksOf(value)['CustomEvent']).toBeUndefined();
    expect(changes).toEqual([
      { event: 'UserPromptSubmit', kind: 'removed', count: 1 },
      { event: 'CustomEvent', kind: 'removed', count: 1 },
    ]);
  });

  it('removes stale entries under any path and keeps user groups', () => {
    const { value } = planUninstall(load('stale-awaiting-entry.json'));
    expect(value).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      },
    });
  });

  it('leaves pre-existing empty containers that never held our entries', () => {
    const input = { hooks: { PostToolUse: [], Stop: [{ hooks: [] }] }, other: 1 };
    const { value, changes } = planUninstall(input);
    expect(value).toEqual(input);
    expect(changes).toEqual([]);
  });

  it('keeps an empty hooks object if it was empty before', () => {
    expect(planUninstall({ hooks: {} }).value).toEqual({ hooks: {} });
  });

  it('drops hooks when our removal emptied it', () => {
    const installed = planInstall({ a: 1 }, opts).value;
    expect(planUninstall(installed).value).toEqual({ a: 1 });
  });
});

describe('jsonEqual', () => {
  it('ignores key order but not array order', () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual({ b: [2, 1] }, { b: [1, 2] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});
