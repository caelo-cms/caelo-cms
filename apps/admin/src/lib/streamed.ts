// SPDX-License-Identifier: MPL-2.0

/**
 * #1268 — parts of a page load that arrive after first paint.
 *
 * A server load returns these as promises, so SvelteKit sends the page
 * before they are ready and streams each one in when it settles. Each
 * promise resolves to a value or to the reason it failed and never
 * rejects: a rejected streamed promise passes through `handleError`
 * and reaches the client as a generic message. Here the editor shows
 * the failure in the spot the part would fill, instead of dropping the
 * part without a word (CLAUDE.md §2: no silent fallbacks).
 */

/** One streamed part of a load: its value, or why it could not be loaded. */
export type Streamed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Called when a streamed step settles, with its duration in milliseconds. */
export type StepObserver = (step: string, ms: number, ok: boolean) => void;

/**
 * Runs one streamed step. A thrown error becomes `{ ok: false }` with
 * `<what> could not be loaded: <reason>`, so the result names the part.
 *
 * @param what - the part as the operator knows it, e.g. "Other open chats".
 * @param observe - told the step's duration; the load logs slow steps.
 */
export async function settle<T>(
  what: string,
  run: () => Promise<T>,
  observe?: StepObserver,
): Promise<Streamed<T>> {
  const started = performance.now();
  try {
    const value = await run();
    observe?.(what, performance.now() - started, true);
    return { ok: true, value };
  } catch (e) {
    observe?.(what, performance.now() - started, false);
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `${what} could not be loaded: ${reason}` };
  }
}

/**
 * A queue that runs its steps one after another, each with a promise of
 * its own. The streamed reads of one load share a few lanes instead of
 * all opening a database connection at once: a load then holds as many
 * pooled connections as it has lanes (#1254's connection budget), and a
 * slow step delays only the steps in its own lane.
 */
export function createLane(): <T>(step: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(step: () => Promise<T>): Promise<T> => {
    const next = tail.then(step);
    // The next step waits for this one to settle, not to succeed.
    tail = next.catch(() => undefined);
    return next;
  };
}
