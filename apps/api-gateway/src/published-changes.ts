// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — when the gateway may serve what it read from the admin's
 * published projection out of memory.
 *
 * The admin's publisher NOTIFYs `caelo_gateway_settings` on cms_public after
 * every publish (#635). Before this, the gateway's LISTEN never received
 * anything (it iterated a `notifications` property Bun's SQL does not
 * have) and a 5 s TTL hid it: every cache was up to 5 s stale by design,
 * and silently so. Now the caches (settings, staging gate, rate-limit
 * specs, the visitor consent rule) are valid exactly while the LISTEN
 * subscription is acknowledged:
 *
 * - before the first acknowledgement nothing is cached (every request
 *   reads the projection);
 * - each notification drops every cache;
 * - when the LISTEN connection drops, every cache is dropped and nothing
 *   is cached again (every request reads the projection) until the
 *   subscription is acknowledged again — a publish during the gap sends a
 *   notification nobody receives;
 * - each (re)acknowledgement drops every cache once more, because
 *   notifications sent while the connection was down are lost — Bun
 *   reconnects with backoff and re-subscribes.
 *
 * The LISTEN connection is the one outside the pool
 * (`LISTEN_CONNECTIONS_PER_INSTANCE`); a pooled provider in transaction
 * mode breaks LISTEN, so cms_public must be reached directly
 * (docs/dev/state-and-changes.md).
 *
 * #1361 — a notification can be pending when a request starts. The
 * gateway runs on request-billed CPU (Cloud Run `cpuIdle`): between
 * requests the instance is throttled, a NOTIFY that arrives then waits in
 * the socket until CPU returns — with the next request, which could read a
 * cache the notification drops before the LISTEN callback ran (a closed
 * staging gate, a revoked plugin, a rotated cookie secret). So a request
 * that reads published state and starts while no other request is in
 * flight first confirms it ({@link servePublishedRequest}): one read of
 * the projection's section versions, which every publish rewrites in the
 * transaction that notifies, compared with the last confirmation. A
 * difference drops every cache, as the notification will. A request that
 * starts while another is in flight had CPU all along, so its
 * notifications were handled; it confirms only once the last confirmation
 * is older than {@link CONFIRM_MAX_AGE_MS}, which also bounds what a LISTEN
 * connection that died without a word could hide.
 */

import type { DatabaseAdapter, ListenHandle } from "@caelo-cms/query-api";

/** The channel the admin's projection publisher notifies (packages/migrations public-projection.ts). */
export const GATEWAY_PROJECTION_CHANNEL = "caelo_gateway_settings";

/**
 * How long a confirmation of the published state holds for requests that
 * start while another one is in flight (see the module docblock).
 */
export const CONFIRM_MAX_AGE_MS = 30_000;

let subscribed = false;
let generation = 0;
const invalidators = new Set<() => void>();
/** Requests this instance serves right now ({@link servePublishedRequest}). */
let inFlight = 0;
/** The section versions the last confirmation saw; null before the first. */
let confirmedVersions: string | null = null;
let confirmedAt = Number.NEGATIVE_INFINITY;
let confirming: Promise<void> | null = null;

/** Whether in-memory copies of published state may be served now. */
export function publishedCacheUsable(): boolean {
  return subscribed;
}

/**
 * Take before reading published state; pass to {@link mayCacheRead} after.
 * A notification that arrives while the read is in flight moves it, so the
 * read's (possibly older) result is not cached over the invalidation.
 */
export function publishedCacheGeneration(): number {
  return generation;
}

/** Whether a read that started at `startedAt` may be stored in a cache. */
export function mayCacheRead(startedAt: number): boolean {
  return subscribed && startedAt === generation;
}

/** Register a cache's drop function; called on every notification and reconnect. */
export function onPublishedChange(invalidate: () => void): void {
  invalidators.add(invalidate);
}

function invalidateAll(): void {
  generation += 1;
  for (const invalidate of invalidators) invalidate();
}

/**
 * Serve one request: count it in flight while `serve` runs, and when it
 * reads published state, confirm that state first if the instance may have
 * idled (no CPU, see the module docblock) — or the last confirmation is
 * older than {@link CONFIRM_MAX_AGE_MS}. Concurrent requests share one
 * confirmation; one that fails drops every cache, so the request reads
 * through instead of trusting what it could not confirm.
 *
 * @param readVersions - the projection's section versions as one string
 *   (`readProjectionVersions` in server.ts; equal strings mean no publish
 *   committed in between), or null for a request that answers from no
 *   cached published state: `/healthz`, a path that names no route, and a
 *   gateway whose feature is known to be off (E14 a answers from memory,
 *   without the database)
 * @param now - milliseconds since the epoch (tests)
 */
export async function servePublishedRequest<T>(
  readVersions: (() => Promise<string>) | null,
  serve: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const wasIdle = inFlight === 0;
  inFlight += 1;
  try {
    if (readVersions) await confirmPublishedState(readVersions, wasIdle, now());
    return await serve();
  } finally {
    inFlight -= 1;
  }
}

function confirmPublishedState(
  readVersions: () => Promise<string>,
  wasIdle: boolean,
  now: number,
): Promise<void> {
  // Nothing is cached while the LISTEN is down: every request reads through.
  if (!subscribed) return Promise.resolve();
  if (confirming) return confirming;
  if (!wasIdle && now - confirmedAt < CONFIRM_MAX_AGE_MS) return Promise.resolve();
  const run = (async () => {
    try {
      const versions = await readVersions();
      if (versions !== confirmedVersions) {
        // A publish committed since the last confirmation; its notification
        // may still be waiting in the socket.
        invalidateAll();
        confirmedVersions = versions;
      }
      confirmedAt = now;
    } catch (e) {
      invalidateAll();
      console.warn(
        `[gateway] could not confirm the published state; reading through for this request: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  })().finally(() => {
    if (confirming === run) confirming = null;
  });
  confirming = run;
  return run;
}

/** Forget the confirmation state and the request count (tests). */
export function resetPublishedStateConfirmation(): void {
  inFlight = 0;
  confirmedVersions = null;
  confirmedAt = Number.NEGATIVE_INFINITY;
  confirming = null;
}

/**
 * Subscribe to the projection's notifications. Resolves once Postgres
 * acknowledged the LISTEN; the gateway awaits it at boot, so a gateway that
 * cannot listen fails to start instead of serving stale state.
 */
export async function listenForPublishedChanges(adapter: DatabaseAdapter): Promise<ListenHandle> {
  return adapter.listen("public", GATEWAY_PROJECTION_CHANNEL, {
    onNotify: () => invalidateAll(),
    onListen: () => {
      invalidateAll();
      subscribed = true;
    },
    onLost: (cause) => {
      subscribed = false;
      invalidateAll();
      console.warn(
        `[gateway] the published-state LISTEN connection dropped; reading through until it is back: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    },
  });
}
