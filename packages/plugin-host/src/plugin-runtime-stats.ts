// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1390 — what a plugin's work costs this instance, and whether its
 * change consumer is backing off, kept in process and written to
 * `plugin_runtime` with the heartbeat (runtime-health.ts), so plugin health
 * (`get_plugin`, Settings → Plugins) can name the plugin that holds the
 * database.
 *
 * The production case it exists for (searchVIU, 2026-11-03): a consumer ran
 * a site-sized core read after every agent write and timed out each time,
 * and nothing pointed at it. Recording costs one map update per broker call
 * and no database write; the heartbeat carries the aggregate.
 *
 * Reported only, never acted on: no number here throttles, disables or
 * reorders a plugin (CLAUDE.md §2, #1008 — a plugin's status is the
 * Owner's decision).
 */

/** Calls, total and longest duration of one core operation a plugin called. */
export interface OpCost {
  calls: number;
  totalMs: number;
  maxMs: number;
}

/** A change consumer that is waiting out its failure backoff on this instance. */
export interface ConsumerBackoffState {
  readonly consecutiveFailures: number;
  /** When the failed batch is retried (ISO). */
  readonly nextRetryAt: string;
  readonly lastError: string;
}

/**
 * Operation names kept per plugin. Names come from the plugin (an unknown
 * name is still a call that costs a lookup), so the map is bounded; calls
 * beyond it fold into {@link OTHER_OPS}.
 */
const MAX_OPS_PER_PLUGIN = 100;
/** Where calls past {@link MAX_OPS_PER_PLUGIN} distinct names are counted. */
export const OTHER_OPS = "(other operations)";

const costs = new Map<string, Map<string, OpCost>>();
/**
 * A cleared backoff stays as `null` (instead of being deleted) so the next
 * heartbeat writes the cleared state over the one it wrote before.
 */
const backoffs = new Map<string, ConsumerBackoffState | null>();
/** Since when this process counts (the `op_cost_since` it reports). */
const COUNTING_SINCE = new Date().toISOString();

/**
 * Count one core operation call of `slug` that took `ms` (wall time of the
 * call through the broker: pool checkout plus the operation's statements).
 */
export function recordPluginOpCall(slug: string, opName: string, ms: number): void {
  let ops = costs.get(slug);
  if (!ops) {
    ops = new Map();
    costs.set(slug, ops);
  }
  const key = ops.has(opName) || ops.size < MAX_OPS_PER_PLUGIN ? opName : OTHER_OPS;
  const rounded = Math.max(0, Math.round(ms));
  const c = ops.get(key);
  if (c) {
    c.calls += 1;
    c.totalMs += rounded;
    c.maxMs = Math.max(c.maxMs, rounded);
  } else {
    ops.set(key, { calls: 1, totalMs: rounded, maxMs: rounded });
  }
}

/**
 * Run `call` (one broker call of a core operation for `slug`) and count its
 * duration, whether it succeeds or throws.
 */
export async function timedPluginOpCall<T>(
  slug: string,
  opName: string,
  call: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await call();
  } finally {
    recordPluginOpCall(slug, opName, performance.now() - started);
  }
}

/** Set (or with `null` clear) the backoff state of `slug`'s change consumer. */
export function setConsumerBackoff(slug: string, state: ConsumerBackoffState | null): void {
  if (state || backoffs.has(slug)) backoffs.set(slug, state);
}

/** What the heartbeat writes for one plugin. */
export interface PluginRuntimeStats {
  readonly slug: string;
  readonly opCost: Record<string, OpCost>;
  readonly opCostSince: string;
  readonly consumerBackoff: ConsumerBackoffState | null;
}

/**
 * The current aggregate of every plugin with counted calls or a backoff
 * state. Cumulative since the process started: a heartbeat that could not
 * be written loses nothing, the next one carries it.
 */
export function pluginRuntimeStats(): PluginRuntimeStats[] {
  const slugs = new Set([...costs.keys(), ...backoffs.keys()]);
  return [...slugs].map((slug) => ({
    slug,
    opCost: Object.fromEntries(
      [...(costs.get(slug) ?? new Map<string, OpCost>())].map(([op, c]) => [op, { ...c }]),
    ),
    opCostSince: COUNTING_SINCE,
    consumerBackoff: backoffs.get(slug) ?? null,
  }));
}

/** Forget everything counted (tests, plugin host reset). */
export function resetPluginRuntimeStats(): void {
  costs.clear();
  backoffs.clear();
}
