// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway garbage-collects its own state (issue #635, #763 L4).
 *
 * The admin's redeploy orchestrator used to sweep the gateway's tables,
 * which meant a scaled-to-zero admin left them growing while the public
 * side kept writing. They live in cms_public now, so the gateway sweeps
 * them itself, at most hourly, expired rows only — the cms_public RLS policies
 * (migration 0280) let public_role delete nothing younger than these
 * windows, whatever this code asks for.
 *
 * Fixed DELETE statements through the adapter's `withPublicTransaction`
 * as the `system` actor, not Query API ops: housekeeping of the gateway's
 * own expired rows takes no input and changes nothing anyone authored, so
 * there is nothing to validate or attribute; RLS bounds it either way.
 *
 * The sweep runs inside a request, not on a timer: the gateway gets CPU only
 * while it handles one (Cloud Run request-based CPU, stack-contract.ts
 * SERVICE_CPU_IDLE), and the rows only grow when requests arrive anyway.
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

/**
 * Returns a function that runs `sweep` when the last one started at least
 * `intervalMs` ago, and resolves at once otherwise — also while another
 * request's sweep is still running, so at most one request per interval
 * waits on it. A failed sweep is logged and retried after the interval.
 */
export function dueSweeper(
  sweep: () => Promise<void>,
  intervalMs = GC_INTERVAL_MS,
  now: () => number = Date.now,
): () => Promise<void> {
  let lastStartedAt: number | null = null;
  return async () => {
    if (lastStartedAt !== null && now() - lastStartedAt < intervalMs) return;
    lastStartedAt = now();
    await sweep().catch((e: unknown) => {
      console.error(
        `[api-gateway] state GC failed: ${e instanceof Error ? e.name : "non-Error thrown"}`,
      );
    });
  };
}

/** The gateway's sweep of its own state, run from the request handler when due. */
export function gatewayStateGc(adapter: DatabaseAdapter): () => Promise<void> {
  return dueSweeper(() => sweepGatewayState(adapter));
}
