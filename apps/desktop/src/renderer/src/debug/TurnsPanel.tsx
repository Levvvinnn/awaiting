import type { DebugTurnRow } from '../../../shared/debug-types';
import { formatClock, shortSessionId, turnKey, turnTiming } from './state';

interface TurnsPanelProps {
  readonly turns: readonly DebugTurnRow[];
}

/** Turns with their status and measured wall time (never an estimate). */
export function TurnsPanel({ turns }: TurnsPanelProps) {
  return (
    <section className="debug-panel" aria-labelledby="debug-turns-title">
      <h2 id="debug-turns-title">
        Turns <span className="debug-count">{String(turns.length)}</span>
      </h2>
      {turns.length === 0 ? (
        <p className="debug-empty">No turns yet.</p>
      ) : (
        <div className="debug-scroll" tabIndex={0} aria-label="Turn list (scrollable)">
          <table className="debug-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Turn</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Wall time</th>
                <th scope="col">Events</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t) => (
                <tr key={turnKey(t)}>
                  <td className="debug-mono" title={t.sessionId}>
                    {shortSessionId(t.sessionId)}
                  </td>
                  <td>#{String(t.seq)}</td>
                  <td>
                    <span className={`debug-status debug-status-${t.status}`}>
                      {t.endReason === null ? t.status : `${t.status} / ${t.endReason}`}
                    </span>
                  </td>
                  <td className="debug-mono">{formatClock(t.startedAt)}</td>
                  <td>{turnTiming(t)}</td>
                  <td>{String(t.eventCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
