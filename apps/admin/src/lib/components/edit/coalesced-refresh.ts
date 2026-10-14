// SPDX-License-Identifier: MPL-2.0

/**
 * Single-flight with a trailing re-run, for "fetch the latest state now"
 * calls.
 *
 * A plain in-flight guard (`if (busy) return`) drops a refresh requested
 * while an older one is still on the wire. That older fetch may have read the
 * state from BEFORE the change the caller just made, so the caller's refresh
 * never happens and the UI shows stale data until the next poll tick. In the
 * quality-gate poller this is how the "Let the AI fix them?" card stayed up
 * for 20 s after "Fix with AI": the post-ack refresh was dropped behind a
 * refresh that had started before the ack committed.
 *
 * Here a call during a run schedules exactly one more run after it (however
 * many calls arrive meanwhile). The promise every caller gets resolves only
 * after a run that STARTED after its call, so `await refresh()` always sees
 * state at least as new as the call.
 *
 * @param task one fetch-and-apply pass. If it rejects, the pending re-run is
 *   dropped and callers get the rejection.
 * @returns the coalescing trigger.
 */
export function coalescedRefresh(task: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let again = false;
  return () => {
    if (current !== null) {
      again = true;
      return current;
    }
    const run = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        current = null;
      }
    })();
    current = run;
    return run;
  };
}
