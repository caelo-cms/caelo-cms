// SPDX-License-Identifier: MPL-2.0

/**
 * Hourly sweep of the admin's own login rate-limit buckets
 * (`rate_limit_buckets` in cms_admin): rows that expired more than an hour
 * ago are deleted. The gateway sweeps its own state in cms_public
 * (apps/api-gateway/src/gc.ts).
 *
 * Started once per admin process from `apps/admin/src/hooks.server.ts`. It
 * lived in the redeploy orchestrator until the automatic redeploy was
 * removed (#1154); its cadence moves to the scheduler tick under epic
 * #1140. Best-effort: a failed sweep is logged and the next one retries
 * (stale buckets only cost space, never a wrong limit — they are expired).
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "rate-limit-gc",
};

const GC_INTERVAL_MS = 60 * 60 * 1000;

/** Delete the expired login rate-limit buckets once. Exported for tests. */
export async function sweepExpiredRateLimitBuckets(adapter: DatabaseAdapter): Promise<void> {
  await adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
    await tx.execute(
      sql`DELETE FROM rate_limit_buckets WHERE expires_at < now() - interval '1 hour'`,
    );
  });
}

/**
 * Start the hourly sweep. Returns a stop handle (tests; the admin process
 * runs it for its lifetime).
 *
 * @param opts.intervalMs - override the hourly cadence (tests).
 */
export function startRateLimitGcWorker(opts: {
  readonly adapter: DatabaseAdapter;
  readonly intervalMs?: number;
}): { stop(): void } {
  const handle = setInterval(() => {
    sweepExpiredRateLimitBuckets(opts.adapter).catch((e: unknown) => {
      console.error("[rate-limit-gc] sweep failed", e);
    });
  }, opts.intervalMs ?? GC_INTERVAL_MS);
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
