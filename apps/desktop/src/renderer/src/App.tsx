import { DebugView } from './debug/DebugView';

// Live data from main over the preload bridge (plan 01 §3.9). The bridge exposes `debug` in the
// main window only; debug/mock.ts is test data and is never imported here.
export function App() {
  const debug = window.awaiting.debug;
  return (
    <main>
      {debug === undefined ? (
        <p role="alert">The debug feed is not available in this window.</p>
      ) : (
        <DebugView source={debug} />
      )}
    </main>
  );
}
