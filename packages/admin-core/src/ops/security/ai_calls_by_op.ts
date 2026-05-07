// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.40 — `audit_events.aggregate_by_op_prefix`. Per-domain AI
 * activity attribution. The operator wants to see "AI is busy with
 * users.* this month, less so with snapshots.*" so they can reason
 * about where time is going.
 *
 * Why op-count instead of cost: ai_calls.cost_estimate_microcents is
 * per-turn (one row per provider call), but a single turn may invoke
 * many ops. Splitting cost per-op requires per-op timing tracking
 * we don't currently have. Counting AI-attributed audit_events per
 * op-prefix gives a cleaner, lossless signal.
 *
 * Output: each row reports per op-prefix (everything before the
 * first dot of `operation`):
 *   - opCount: number of AI-attributed audit rows in the window
 *   - sessions: distinct chat sessions that hit the prefix
 *   - successRate: % succeeded=true (helps spot domains where the
 *     AI is failing repeatedly — tune tool descriptions / pre-flight)
 *
 * Window: defaults to 30d.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const rowSchema = z.object({
  opPrefix: z.string(),
  opCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  failureCount: z.number().int().nonnegative(),
});

export const aggregateAuditByOpPrefixOp = defineOperation({
  name: "audit_events.aggregate_by_op_prefix",
  // Open to operator + AI; AI can self-introspect "where am I spending
  // time?" via this op when planning bulk vs singular work.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      sinceIso: z.string().datetime().optional(),
      /** Limit to AI-actor events (default true). False includes all actors. */
      aiOnly: z.boolean().optional(),
    })
    .strict(),
  output: z.object({ rows: z.array(rowSchema), windowSinceIso: z.string() }),
  handler: async (_ctx, input, tx) => {
    const since = input.sinceIso ?? new Date(Date.now() - 30 * 86400_000).toISOString();
    const aiOnly = input.aiOnly ?? true;
    const rows = (await tx.execute(sql`
      WITH events AS (
        SELECT
          split_part(ae.operation, '.', 1) AS op_prefix,
          ae.succeeded
        FROM audit_events ae
        ${aiOnly ? sql`JOIN actors a ON a.id = ae.actor_id AND a.kind = 'ai'` : sql``}
        WHERE ae.created_at >= ${since}::timestamptz
          AND ae.operation LIKE '%.%'
      )
      SELECT
        op_prefix,
        count(*)::int AS op_count,
        SUM(CASE WHEN succeeded THEN 0 ELSE 1 END)::int AS failure_count
      FROM events
      GROUP BY op_prefix
      ORDER BY op_count DESC
    `)) as unknown as Array<{
      op_prefix: string;
      op_count: number;
      failure_count: number;
    }>;
    return ok({
      windowSinceIso: since,
      rows: rows.map((r) => ({
        opPrefix: r.op_prefix,
        opCount: r.op_count,
        failureCount: r.failure_count,
        successRate: r.op_count === 0 ? 1 : 1 - r.failure_count / r.op_count,
      })),
    });
  },
});
