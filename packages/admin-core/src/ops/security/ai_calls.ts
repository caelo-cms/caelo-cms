// SPDX-License-Identifier: MPL-2.0

/**
 * Aggregate ai_calls for the cost dashboard. Read-only — call rows are
 * inserted by the chat runtime, not via this op.
 */

import { defineOperation } from "@caelo/query-api";
import { ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const aggregateAiCallsOp = defineOperation({
  name: "ai_calls.aggregate",
  // CLAUDE.md §11: AI summarises its own usage on user request
  // ("what have I been spending on AI calls today?").
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({
    /** ISO timestamp lower bound. Default: 30 days ago. */
    since: z.string().datetime().optional(),
  }),
  output: z.object({
    totals: z.object({
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
    perDay: z.array(
      z.object({
        day: z.string(),
        calls: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const since = input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const totalsRows = (await tx.execute(sql`
      SELECT
        COUNT(*)::int AS calls,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
        COALESCE(SUM(cached_tokens), 0)::int AS cached_tokens,
        COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS cost_microcents
      FROM ai_calls
      WHERE created_at >= ${since}
    `)) as unknown as {
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cost_microcents: number | string | bigint;
    }[];
    const t = totalsRows[0]!;
    const totalsCostMicrocents =
      typeof t.cost_microcents === "bigint"
        ? Number(t.cost_microcents)
        : typeof t.cost_microcents === "string"
          ? Number.parseInt(t.cost_microcents, 10)
          : t.cost_microcents;

    const dayRows = (await tx.execute(sql`
      SELECT
        date_trunc('day', created_at)::date::text AS day,
        COUNT(*)::int AS calls,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
        COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS cost_microcents
      FROM ai_calls
      WHERE created_at >= ${since}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 60
    `)) as unknown as {
      day: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_microcents: number | string | bigint;
    }[];

    return ok({
      totals: {
        calls: t.calls,
        inputTokens: t.input_tokens,
        outputTokens: t.output_tokens,
        cachedTokens: t.cached_tokens,
        // microcents (×1e-8 USD) → USD
        costUsd: totalsCostMicrocents / 1e8,
      },
      perDay: dayRows.map((d) => {
        const microcents =
          typeof d.cost_microcents === "bigint"
            ? Number(d.cost_microcents)
            : typeof d.cost_microcents === "string"
              ? Number.parseInt(d.cost_microcents, 10)
              : d.cost_microcents;
        return {
          day: d.day,
          calls: d.calls,
          inputTokens: d.input_tokens,
          outputTokens: d.output_tokens,
          costUsd: microcents / 1e8,
        };
      }),
    });
  },
});
