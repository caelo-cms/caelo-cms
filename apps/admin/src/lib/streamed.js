// SPDX-License-Identifier: MPL-2.0
/**
 * Runs one streamed step. A thrown error becomes `{ ok: false }` with
 * `<what> could not be loaded: <reason>`, so the result names the part.
 *
 * @param what - the part as the operator knows it, e.g. "Other open chats".
 * @param observe - told the step's duration; the load logs slow steps.
 */
export async function settle(what, run, observe) {
    const started = performance.now();
    try {
        const value = await run();
        observe?.(what, performance.now() - started, true);
        return { ok: true, value };
    }
    catch (e) {
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
export function createLane() {
    let tail = Promise.resolve();
    return (step) => {
        const next = tail.then(step);
        // The next step waits for this one to settle, not to succeed.
        tail = next.catch(() => undefined);
        return next;
    };
}
