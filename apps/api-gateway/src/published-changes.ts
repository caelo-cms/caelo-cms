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
 * - each (re)acknowledgement drops every cache too, because notifications
 *   sent while the connection was down are lost — Bun reconnects with
 *   backoff and re-subscribes.
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
const invalidators = new Set<() => void>();

/** Whether in-memory copies of published state may be served now. */
export function publishedCacheUsable(): boolean {
  return subscribed;
}

/** Register a cache's drop function; called on every notification and reconnect. */
export function onPublishedChange(invalidate: () => void): void {
  invalidators.add(invalidate);
}

function invalidateAll(): void {
  for (const invalidate of invalidators) invalidate();
}

/**
 * Subscribe to the projection's notifications. Resolves once Postgres
 * acknowledged the LISTEN; the gateway awaits it at boot, so a gateway that
 * cannot listen fails to start instead of serving stale state.
 */
export async function listenForPublishedChanges(adapter: DatabaseAdapter): Promise<ListenHandle> {
  return adapter.listen(
    "public",
    GATEWAY_PROJECTION_CHANNEL,
    () => invalidateAll(),
    () => {
      invalidateAll();
      subscribed = true;
    },
  );
}
