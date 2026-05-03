// SPDX-License-Identifier: MPL-2.0

/**
 * P16 hardening — track consecutive cap-lookup failures so a flaky DB
 * query doesn't silently disable AI cost enforcement.
 *
 * The plugin-host's `ctx.ai.complete` and chat-runner's daily-budget
 * pre-flight both consult `ai_calls.aggregate_per_plugin` /
 * `ai_budgets.status` before dispatching to the provider. Today a thrown
 * error there is swallowed (so a working plugin doesn't break on a DB
 * hiccup). That's the right default — but unbounded silent retries =
 * "no enforcement at all under sustained DB pressure".
 *
 * The counter trips a per-key fail-closed mode after `LOOKUP_FAIL_THRESHOLD`
 * consecutive misses; the next call is blocked with a structured error,
 * the trip is reset on the first successful lookup. A success after one
 * miss does NOT trip — only a sustained failure does.
 */

const LOOKUP_FAIL_THRESHOLD = 3;
const counters = new Map<string, number>();

/** Total fail-closed trips since process start — surfaced in /security/costs. */
let totalTrips = 0;

export function recordCapLookupSuccess(key: string): void {
  counters.delete(key);
}

/**
 * Record a cap-lookup failure. Returns `true` when the threshold has been
 * crossed and the caller MUST fail closed instead of swallowing the error.
 */
export function recordCapLookupFailure(key: string): boolean {
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  if (next === LOOKUP_FAIL_THRESHOLD) {
    totalTrips++;
    // biome-ignore lint/suspicious/noConsole: structured warning visibility
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "ai-cap-lookup fail-closed tripped",
        key,
        consecutiveFailures: next,
      }),
    );
  }
  return next >= LOOKUP_FAIL_THRESHOLD;
}

/** Snapshot for the cost dashboard. */
export function getCapLookupHealth(): {
  trippedKeys: Array<{ key: string; consecutiveFailures: number }>;
  totalTrips: number;
} {
  const tripped: Array<{ key: string; consecutiveFailures: number }> = [];
  for (const [key, count] of counters.entries()) {
    if (count >= LOOKUP_FAIL_THRESHOLD) tripped.push({ key, consecutiveFailures: count });
  }
  return { trippedKeys: tripped, totalTrips };
}

/** Test-only reset. */
export function resetCapLookupCounters(): void {
  counters.clear();
  totalTrips = 0;
}
