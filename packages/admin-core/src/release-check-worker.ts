// SPDX-License-Identifier: MPL-2.0

/**
 * P21 ship 5 — polls GitHub for the latest Caelo release and writes the
 * result to `release_check_cache` (singleton row).
 *
 * Why this exists: P20 ship 4 inlined the GitHub fetch inside
 * `notifications.aggregate`'s op handler — which runs INSIDE a
 * Postgres transaction. A slow GitHub held the connection open for
 * up to 5s, opening a connection-pool exhaustion vector. The fetch
 * is now hoisted out: this task runs outside any request's op, the op
 * just reads the cached row.
 *
 * Cadence: hourly, on the scheduler tick (#1140, scheduler/core-tasks.ts).
 * AbortSignal timeout 5s per fetch. Failures cache the negative result
 * (NULL) so the next op call still answers fast. The fetch and the cache
 * write live in platform-updates/release-check.ts, shared with Settings →
 * Updates' "Check now".
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { SYSTEM_ACTOR_ID } from "./audit.js";
import {
  fetchLatestRelease,
  predictReleaseRoute,
  type RoutePredictionOpts,
  writeReleaseCheck,
} from "./platform-updates/release-check.js";

/** What {@link runReleaseCheck} needs. */
export interface ReleaseCheckOpts extends RoutePredictionOpts {
  readonly adapter: DatabaseAdapter;
  /** Override fetch URL — tests / forks. */
  readonly url?: string;
}

let polls = 0;

/**
 * One check: fetch the newest release (outside any transaction), read its
 * manifest for its route (does it change the cloud setup, #817), and cache
 * the outcome. A failed fetch is cached as "no release" with the time, so
 * Settings → Updates says the last check failed; the next hourly run retries.
 */
export async function runReleaseCheck(opts: ReleaseCheckOpts): Promise<void> {
  const outcome = await predictReleaseRoute(
    await fetchLatestRelease(opts.url ? { url: opts.url } : {}),
    opts,
  );
  await opts.adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `release-check-${polls++}` },
    (tx) => writeReleaseCheck(tx, outcome),
  );
}
