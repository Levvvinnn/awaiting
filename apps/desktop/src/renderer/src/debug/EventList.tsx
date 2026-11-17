import type { DebugEventRow } from '../../../shared/debug-types';
import { formatClock, shortSessionId } from './state';

interface EventListProps {
  readonly rows: readonly DebugEventRow[];
  readonly total: number;
}

/** The event table, newest first. */
export function EventList({ rows, total }: EventListProps) {
  return (
    <section className="debug-panel" aria-labelledby="debug-events-title">
      <h2 id="debug-events-title">
        Events{' '}
        <span className="debug-count">
          {rows.length === total ? String(total) : `${String(rows.length)} of ${String(total)}`}
        </span>
      </h2>
      {rows.length === 0 ? (
        <p className="debug-empty">No events match.</p>
      ) : (
        <div className="debug-scroll" tabIndex={0} aria-label="Event list (scrollable)">
          <table className="debug-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Session</th>
                <th scope="col">Turn</th>
                <th scope="col">Tool / type</th>
                <th scope="col">Agent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="debug-mono">{formatClock(r.receivedAt)}</td>
                  <td>{r.eventName}</td>
                  <td className="debug-mono" title={r.sessionId}>
                    {shortSessionId(r.sessionId)}
                  </td>
                  <td>{r.turnSeq === null ? '—' : `#${String(r.turnSeq)}`}</td>
                  <td>{r.toolName ?? r.notificationType ?? ''}</td>
                  <td>{r.agentType ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
