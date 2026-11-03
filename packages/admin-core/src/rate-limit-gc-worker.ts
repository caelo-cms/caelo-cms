// SPDX-License-Identifier: MPL-2.0

/**
 * Hourly sweep of the admin's own login rate-limit buckets
 * (`rate_limit_buckets` in cms_admin): rows that expired more than an hour
 * ago are deleted. The gateway sweeps its own state in cms_public
 * (apps/api-gateway/src/gc.ts).
 *
 * Runs on the scheduler tick (#1140, scheduler/core-tasks.ts), hourly. A
 * failed sweep is recorded and the next one retries (stale buckets only
 * cost space, never a wrong limit — they are expired).
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "rate-limit-gc",
};

/** Delete the expired login rate-limit buckets once. */
export async function sweepExpiredRateLimitBuckets(adapter: DatabaseAdapter): Promise<void> {
  await adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
    await tx.execute(
      sql`DELETE FROM rate_limit_buckets WHERE expires_at < now() - interval '1 hour'`,
    );
  });
}
