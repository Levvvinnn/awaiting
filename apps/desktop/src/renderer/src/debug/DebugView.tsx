import { HOOK_EVENT_NAMES, type HookEventName } from '@awaiting/core';
import { useEffect, useMemo, useState } from 'react';
import type { DebugBridge } from '../../../shared/bridge';
import { EventList } from './EventList';
import { TurnsPanel } from './TurnsPanel';
import {
  EMPTY_STATE,
  applyUpdate,
  filterEvents,
  fromSnapshot,
  sessionIds,
  type DebugState,
} from './state';
import './debug.css';

interface DebugViewProps {
  /** Snapshot + update feed: `window.awaiting.debug` (tests may pass a mock). */
  readonly source: DebugBridge;
  /** Shown in the header when the data is not live. */
  readonly sourceLabel?: string;
}

const ALL_NAMES: ReadonlySet<HookEventName> = new Set(HOOK_EVENT_NAMES);

/** Live hook-event debug view (plan 01 §3.9): timestamps and measured durations only. */
export function DebugView({ source, sourceLabel }: DebugViewProps) {
  const [state, setState] = useState<DebugState>(EMPTY_STATE);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventNames, setEventNames] = useState<ReadonlySet<HookEventName>>(ALL_NAMES);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    let active = true;
    // Subscribe first so nothing pushed during the snapshot round-trip is lost.
    const unsubscribe = source.onUpdate((update) => {
      if (active) setState((s) => applyUpdate(s, update));
    });
    source
      .getSnapshot()
      .then((snapshot) => {
        if (!active) return;
        setState((s) => {
          const base = fromSnapshot(snapshot);
          return applyUpdate(base, { events: s.events, turns: s.turns });
        });
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [source]);

  const sessions = useMemo(
    () => sessionIds(state.events, state.turns),
    [state.events, state.turns],
  );
  const visible = useMemo(
    () => filterEvents(state.events, { eventNames, sessionId, text }),
    [state.events, eventNames, sessionId, text],
  );
  const visibleTurns = useMemo(
    () => (sessionId === null ? state.turns : state.turns.filter((t) => t.sessionId === sessionId)),
    [state.turns, sessionId],
  );

  const toggleName = (name: HookEventName): void => {
    setEventNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const { server, privacy } = state;

  return (
    <div className="debug-view">
      <header className="debug-header">
        <h1>Debug: hook events</h1>
        <dl className="debug-status-list">
          <div>
            <dt>Server</dt>
            <dd>
              {server.listening && server.port !== null
                ? `listening on 127.0.0.1:${String(server.port)}`
                : 'not listening'}
            </dd>
          </div>
          <div>
            <dt>Raw prompt storage</dt>
            <dd>{privacy.storeRawPrompt ? 'on' : 'off'}</dd>
          </div>
          {sourceLabel !== undefined && (
            <div>
              <dt>Data</dt>
              <dd className="debug-mock">{sourceLabel}</dd>
            </div>
          )}
        </dl>
        {loadError !== null && (
          <p className="debug-error" role="alert">
            Could not load the snapshot: {loadError}
          </p>
        )}
      </header>

      <form
        className="debug-filters"
        aria-label="Event filters"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <fieldset>
          <legend>Event types</legend>
          <div className="debug-checks">
            {HOOK_EVENT_NAMES.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={eventNames.has(name)}
                  onChange={() => {
                    toggleName(name);
                  }}
                />
                {name}
              </label>
            ))}
          </div>
          <div className="debug-check-actions">
            <button
              type="button"
              onClick={() => {
                setEventNames(ALL_NAMES);
              }}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => {
                setEventNames(new Set());
              }}
            >
              None
            </button>
          </div>
        </fieldset>
        <label className="debug-field">
          Session
          <select
            value={sessionId ?? ''}
            onChange={(e) => {
              setSessionId(e.target.value === '' ? null : e.target.value);
            }}
          >
            <option value="">All sessions</option>
            {sessions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="debug-field">
          Tool or notification type
          <input
            type="search"
            value={text}
            placeholder="e.g. Bash, idle_prompt"
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </label>
      </form>

      <TurnsPanel turns={visibleTurns} />
      <EventList rows={visible} total={state.events.length} />
    </div>
  );
}
