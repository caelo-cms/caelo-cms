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
 */

import type { DatabaseAdapter, ListenHandle } from "@caelo-cms/query-api";

/** The channel the admin's projection publisher notifies (packages/migrations public-projection.ts). */
export const GATEWAY_PROJECTION_CHANNEL = "caelo_gateway_settings";

let subscribed = false;
let generation = 0;
const invalidators = new Set<() => void>();

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
