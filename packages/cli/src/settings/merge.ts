// Pure settings.json merge for install/uninstall (plan 01 §3.10, D1.8, D1.9). No fs.
// Inputs are already-validated JSON values (see io.ts); outputs are fresh copies.
import { HOOK_EVENT_NAMES, HOOK_SCRIPT_BASENAME, desiredGroup, desiredHandler } from '../events';
import type { HookEventName, HookForm } from '../events';

export type JsonObject = { [key: string]: unknown };

export type InstallChangeKind = 'added' | 'updated' | 'unchanged' | 'deduped';
export type InstallChange = { event: HookEventName; kind: InstallChangeKind };
export type UninstallChange = { event: string; kind: 'removed'; count: number };

export type InstallOptions = { hookPath: string; form: HookForm };

export function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Last path segment, splitting on both `/` and `\`. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

const COMMAND_TOKEN_RE = /(?:^|[\\/"' ])awaiting-hook\.js(?=$|["' ])/i;

/** True if `handler` is one of ours: a command hook whose args or command reference awaiting-hook.js. */
export function isOurs(handler: unknown): boolean {
  if (!isPlainObject(handler) || handler['type'] !== 'command') return false;
  const args = handler['args'];
  if (Array.isArray(args)) {
    for (const a of args) {
      if (typeof a === 'string' && basename(a).toLowerCase() === HOOK_SCRIPT_BASENAME) return true;
    }
  }
  const command = handler['command'];
  return typeof command === 'string' && COMMAND_TOKEN_RE.test(command);
}

/** Structural equality for JSON values; object key order is ignored. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Group handlers array if the group has the documented shape, else null (left untouched). */
function groupHooks(group: unknown): unknown[] | null {
  if (!isPlainObject(group)) return null;
  const hooks = group['hooks'];
  return Array.isArray(hooks) ? hooks : null;
}

/** Adds or updates our handler on each of the 14 events; removes duplicates of ours. */
export function planInstall(
  settings: JsonObject,
  opts: InstallOptions,
): { value: JsonObject; changes: InstallChange[] } {
  const value = clone(settings);
  const changes: InstallChange[] = [];
  if (!isPlainObject(value['hooks'])) value['hooks'] = {};
  const hooks = value['hooks'] as JsonObject;

  for (const event of HOOK_EVENT_NAMES) {
    const desired = desiredHandler(event, opts.hookPath, opts.form);
    const existing = hooks[event];
    if (!Array.isArray(existing)) {
      hooks[event] = [desiredGroup(event, opts.hookPath, opts.form)];
      changes.push({ event, kind: 'added' });
      continue;
    }
    const groups: unknown[] = existing;
    let found = false;
    let deduped = false;
    for (let gi = 0; gi < groups.length; gi++) {
      const handlers = groupHooks(groups[gi]);
      if (handlers === null) continue;
      let removedHere = false;
      for (let hi = 0; hi < handlers.length; hi++) {
        if (!isOurs(handlers[hi])) continue;
        if (!found) {
          found = true;
          if (jsonEqual(handlers[hi], desired)) {
            changes.push({ event, kind: 'unchanged' });
          } else {
            handlers[hi] = clone(desired);
            changes.push({ event, kind: 'updated' });
          }
        } else {
          handlers.splice(hi, 1);
          hi--;
          removedHere = true;
          deduped = true;
        }
      }
      if (removedHere && handlers.length === 0) {
        // Only ours were in it (every removal above was ours and nothing else is left).
        groups.splice(gi, 1);
        gi--;
      }
    }
    if (!found) {
      groups.push(desiredGroup(event, opts.hookPath, opts.form));
      changes.push({ event, kind: 'added' });
    }
    if (deduped) changes.push({ event, kind: 'deduped' });
  }
  return { value, changes };
}

/** Removes our handlers from every event key; drops containers only our removal emptied. */
export function planUninstall(settings: JsonObject): {
  value: JsonObject;
  changes: UninstallChange[];
} {
  const value = clone(settings);
  const changes: UninstallChange[] = [];
  const hooks = value['hooks'];
  if (!isPlainObject(hooks)) return { value, changes };

  let deletedEvent = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let count = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const handlers = groupHooks(groups[gi]);
      if (handlers === null) continue;
      const before = handlers.length;
      const kept = handlers.filter((h) => !isOurs(h));
      if (kept.length === before) continue;
      count += before - kept.length;
      if (kept.length === 0) {
        groups.splice(gi, 1);
        gi--;
      } else {
        handlers.splice(0, handlers.length, ...kept);
      }
    }
    if (count === 0) continue;
    changes.push({ event, kind: 'removed', count });
    if (groups.length === 0) {
      delete hooks[event];
      deletedEvent = true;
    }
  }
  if (deletedEvent && Object.keys(hooks).length === 0) delete value['hooks'];
  return { value, changes };
}

/** True if any change requires a write. */
export function needsWrite(changes: readonly { kind: string }[]): boolean {
  return changes.some((c) => c.kind !== 'unchanged');
}
