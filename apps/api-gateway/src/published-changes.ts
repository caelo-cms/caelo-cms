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
 * that starts while no other request is in flight marks the published
 * state unconfirmed ({@link servePublishedRequest}), and the first request
 * to read it then confirms it ({@link confirmPublishedState}): one read of
 * the projection's section versions, which every publish rewrites in the
 * transaction that notifies, compared with the last confirmation. A
 * difference drops every cache, as the notification will. server.ts calls
 * it after the cheap per-client gates (the in-memory budget, the staging
 * gate's failure budget), so junk is shed before this read too. While
 * requests keep coming the instance had CPU all along and its notifications
 * were handled; it confirms again only once the last confirmation is older
 * than {@link CONFIRM_MAX_AGE_MS}, which also bounds what a LISTEN
 * connection that died without a word could hide.
 */

import type { DatabaseAdapter, ListenHandle } from "@caelo-cms/query-api";

/** The channel the admin's projection publisher notifies (packages/migrations public-projection.ts). */
export const GATEWAY_PROJECTION_CHANNEL = "caelo_gateway_settings";

/**
 * How long a confirmation of the published state holds while requests keep
 * coming (see the module docblock).
 */
export const CONFIRM_MAX_AGE_MS = 30_000;

let subscribed = false;
let generation = 0;
const invalidators = new Set<() => void>();
/** Requests this instance serves right now ({@link servePublishedRequest}). */
let inFlight = 0;
/**
 * A notification may have been missed since the last confirmation: set
 * when a request starts on an idle instance (it had no CPU before), cleared
 * by a confirmation. True at boot: nothing is confirmed yet.
 */
let mayHaveMissed = true;
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
 * Serve one request, counting it in flight while `serve` runs. A request
 * that starts while none is in flight marks the published state
 * unconfirmed: the instance had no CPU before it, so a notification may
 * still wait in the socket ({@link confirmPublishedState}).
 */
export async function servePublishedRequest<T>(serve: () => Promise<T>): Promise<T> {
  if (inFlight === 0) mayHaveMissed = true;
  inFlight += 1;
  try {
    return await serve();
  } finally {
    inFlight -= 1;
  }
}

/**
 * Confirm the published state before answering from memory: when the
 * instance may have missed a notification since the last confirmation (it
 * idled, {@link servePublishedRequest}), or that confirmation is older than
 * {@link CONFIRM_MAX_AGE_MS}. Call it right before the first read of cached
 * state that decides the answer, after the cheap per-client gates.
 * Concurrent requests share one confirmation; one that fails drops every
 * cache, so the request reads through instead of trusting what it could
 * not confirm, and the next request tries again.
 *
 * @param readVersions - the projection's section versions as one string
 *   (`readProjectionVersions` in server.ts); equal strings mean no publish
 *   committed in between
 * @param now - milliseconds since the epoch (tests)
 */
export function confirmPublishedState(
  readVersions: () => Promise<string>,
  now: number = Date.now(),
): Promise<void> {
  // Nothing is cached while the LISTEN is down: every request reads through.
  if (!subscribed) return Promise.resolve();
  if (confirming) return confirming;
  if (!mayHaveMissed && now - confirmedAt < CONFIRM_MAX_AGE_MS) return Promise.resolve();
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
      // The confirming request is in flight, so no request started on an
      // idle instance meanwhile: nothing can have been missed since.
      mayHaveMissed = false;
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
  mayHaveMissed = true;
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
