// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway garbage-collects its own state (issue #635, #763 L4).
 *
 * The admin's redeploy orchestrator used to sweep the gateway's tables,
 * which meant a scaled-to-zero admin left them growing while the public
 * side kept writing. They live in cms_public now, so the gateway sweeps
 * them itself, hourly, expired rows only — the cms_public RLS policies
 * (migration 0280) let public_role delete nothing younger than these
 * windows, whatever this code asks for.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

const GC_INTERVAL_MS = 60 * 60 * 1000;

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-gc",
};

/** One sweep: delete expired buckets, challenges, log rows and op events. */
export async function sweepGatewayState(adapter: DatabaseAdapter): Promise<void> {
  await adapter.withPublicTransaction(SYSTEM_CTX, async (tx) => {
    await tx.execute(
      sql`DELETE FROM gateway_rate_limit_buckets WHERE expires_at < now() - interval '1 hour'`,
    );
    await tx.execute(
      sql`DELETE FROM gateway_pow_challenges WHERE expires_at < now() - interval '1 hour'`,
    );
    await tx.execute(
      sql`DELETE FROM gateway_request_log WHERE created_at < now() - interval '90 days'`,
    );
    await tx.execute(
      sql`DELETE FROM gateway_plugin_op_events WHERE created_at < now() - interval '30 days'`,
    );
  });
}

/** Sweep hourly for the process lifetime; a failed sweep is logged and retried next hour. */
export function startGatewayStateGc(adapter: DatabaseAdapter): void {
  setInterval(() => {
    sweepGatewayState(adapter).catch((e: unknown) => {
      console.error(
        `[api-gateway] state GC failed: ${e instanceof Error ? e.name : "non-Error thrown"}`,
      );
    });
  }, GC_INTERVAL_MS);
}
