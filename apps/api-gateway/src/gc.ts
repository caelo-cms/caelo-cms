// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway garbage-collects its own state (issue #635, #763 L4).
 *
 * The admin's redeploy orchestrator used to sweep the gateway's tables,
 * which meant a scaled-to-zero admin left them growing while the public
 * side kept writing. They live in cms_public now, so the gateway sweeps
 * them itself, at most hourly, expired rows only — the cms_public RLS policies
 * (migrations 0280, 0500) let public_role delete nothing younger than these
 * windows, whatever this code asks for.
 *
 * Batched (#1338): each statement deletes at most {@link GC_BATCH_ROWS}
 * rows picked by primary key, in a transaction of its own, so a sweep after
 * a flood never holds a long transaction, a big lock set or a large WAL
 * burst on the one small server every environment shares. A sweep runs at
 * most {@link GC_MAX_BATCHES} batches per table; when one was left full,
 * the next request sweeps again instead of waiting for the interval.
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
import { type SQL, sql } from "drizzle-orm";

const GC_INTERVAL_MS = 60 * 60 * 1000;

/** Rows one GC statement deletes at most. */
export const GC_BATCH_ROWS = 1000;

/** Batches per table and sweep; the rest waits for the next request. */
export const GC_MAX_BATCHES = 10;

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-gc",
};

/**
 * One batch per table: delete up to `limit` expired rows, picked by primary
 * key. The statements take no input; the windows match the RLS policies.
 */
export function gcBatchStatements(limit: number): readonly { table: string; query: SQL }[] {
  return [
    {
      table: "gateway_rate_limit_buckets",
      query: sql`DELETE FROM gateway_rate_limit_buckets WHERE key IN (
        SELECT key FROM gateway_rate_limit_buckets
        WHERE expires_at < now() - interval '1 hour' LIMIT ${limit}) RETURNING 1 AS d`,
    },
    {
      table: "gateway_pow_challenges",
      query: sql`DELETE FROM gateway_pow_challenges WHERE challenge IN (
        SELECT challenge FROM gateway_pow_challenges
        WHERE expires_at < now() - interval '1 hour' LIMIT ${limit}) RETURNING 1 AS d`,
    },
    {
      table: "gateway_request_log",
      query: sql`DELETE FROM gateway_request_log WHERE id IN (
        SELECT id FROM gateway_request_log
        WHERE created_at < now() - interval '90 days' LIMIT ${limit}) RETURNING 1 AS d`,
    },
    {
      table: "gateway_plugin_op_events",
      query: sql`DELETE FROM gateway_plugin_op_events WHERE id IN (
        SELECT id FROM gateway_plugin_op_events
        WHERE created_at < now() - interval '30 days' LIMIT ${limit}) RETURNING 1 AS d`,
    },
    {
      // #1338 — IP-hash keys two days after their day ended (ip-hash-key.ts).
      table: "gateway_ip_hash_keys",
      query: sql`DELETE FROM gateway_ip_hash_keys
        WHERE epoch < floor(extract(epoch FROM now()) / 86400)::int - 2 RETURNING 1 AS d`,
    },
  ];
}

/**
 * One sweep: delete expired buckets, challenges, log rows, op events and
 * IP-hash keys, in batches.
 *
 * @returns whether a table still had a full batch left (sweep again soon).
 */
export async function sweepGatewayState(
  adapter: DatabaseAdapter,
  opts: { readonly batchRows?: number; readonly maxBatches?: number } = {},
): Promise<{ more: boolean }> {
  const limit = opts.batchRows ?? GC_BATCH_ROWS;
  const maxBatches = opts.maxBatches ?? GC_MAX_BATCHES;
  let more = false;
  for (const { query } of gcBatchStatements(limit)) {
    for (let batch = 0; ; batch++) {
      const deleted = await adapter.withPublicTransaction(
        SYSTEM_CTX,
        async (tx) => ((await tx.execute(query)) as unknown as unknown[]).length,
      );
      if (deleted < limit) break;
      if (batch + 1 >= maxBatches) {
        more = true;
        break;
      }
    }
  }
  return { more };
}

/**
 * Returns a function that runs `sweep` when the last one started at least
 * `intervalMs` ago, and resolves at once otherwise — also while another
 * request's sweep is still running, so at most one request per interval
 * waits on it. A sweep that reports `more` is due again on the next
 * request. A failed sweep is logged and retried after the interval.
 */
export function dueSweeper(
  sweep: () => Promise<{ more: boolean } | undefined>,
  intervalMs = GC_INTERVAL_MS,
  now: () => number = Date.now,
): () => Promise<void> {
  let lastStartedAt: number | null = null;
  let running = false;
  return async () => {
    if (running) return;
    if (lastStartedAt !== null && now() - lastStartedAt < intervalMs) return;
    lastStartedAt = now();
    running = true;
    try {
      const result = await sweep();
      if (result?.more) lastStartedAt = null;
    } catch (e) {
      console.error(
        `[api-gateway] state GC failed: ${e instanceof Error ? e.name : "non-Error thrown"}`,
      );
    } finally {
      running = false;
    }
  };
}

/** The gateway's sweep of its own state, run from the request handler when due. */
export function gatewayStateGc(adapter: DatabaseAdapter): () => Promise<void> {
  return dueSweeper(() => sweepGatewayState(adapter));
}
