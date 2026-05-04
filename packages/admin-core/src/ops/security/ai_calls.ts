// SPDX-License-Identifier: MPL-2.0

/**
 * Aggregate ai_calls for the cost dashboard. Read-only — call rows are
 * inserted by the chat runtime, not via this op.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
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
    /** P16 — per (provider, operation_type) breakdown. */
    perProvider: z.array(
      z.object({
        provider: z.string(),
        model: z.string(),
        operationType: z.enum(["text", "image"]),
        calls: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
      }),
    ),
    /** P16 — text vs image roll-up. */
    perOperationType: z.array(
      z.object({
        operationType: z.enum(["text", "image"]),
        calls: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
      }),
    ),
    /** P16 — top-N plugins by spend (NULL plugin_id = chat-runner / direct). */
    perPlugin: z.array(
      z.object({
        pluginId: z.string().nullable(),
        pluginSlug: z.string().nullable(),
        calls: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
      }),
    ),
    /**
     * P16 hardening — unified attribution view. Each row attributes a
     * spend bucket to one of three sources: a plugin (slug), a user
     * (email of the chat session's actor), or a subagent (parent chat
     * session id). Lets operators identify the spend source without
     * cross-referencing audit_events.
     */
    perAttribution: z.array(
      z.object({
        kind: z.enum(["plugin", "user", "subagent", "system"]),
        label: z.string(),
        calls: z.number().int().nonnegative(),
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

    const providerRows = (await tx.execute(sql`
      SELECT
        provider, model, operation_type,
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS cost_microcents
      FROM ai_calls
      WHERE created_at >= ${since}
      GROUP BY provider, model, operation_type
      ORDER BY cost_microcents DESC
      LIMIT 30
    `)) as unknown as Array<{
      provider: string;
      model: string;
      operation_type: "text" | "image";
      calls: number;
      cost_microcents: bigint | string | number;
    }>;

    const opTypeRows = (await tx.execute(sql`
      SELECT operation_type,
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS cost_microcents
      FROM ai_calls
      WHERE created_at >= ${since}
      GROUP BY operation_type
    `)) as unknown as Array<{
      operation_type: "text" | "image";
      calls: number;
      cost_microcents: bigint | string | number;
    }>;

    const pluginRows = (await tx.execute(sql`
      SELECT
        c.plugin_id::text AS plugin_id,
        p.slug AS plugin_slug,
        COUNT(*)::int AS calls,
        COALESCE(SUM(c.cost_estimate_microcents), 0)::bigint AS cost_microcents
      FROM ai_calls c
      LEFT JOIN plugins p ON p.id = c.plugin_id
      WHERE c.created_at >= ${since}
      GROUP BY c.plugin_id, p.slug
      ORDER BY cost_microcents DESC
      LIMIT 20
    `)) as unknown as Array<{
      plugin_id: string | null;
      plugin_slug: string | null;
      calls: number;
      cost_microcents: bigint | string | number;
    }>;

    const toUsd = (v: bigint | string | number): number => {
      const n =
        typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number.parseInt(v, 10) : v;
      return n / 1e8;
    };

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
      perProvider: providerRows.map((r) => ({
        provider: r.provider,
        model: r.model,
        operationType: r.operation_type,
        calls: r.calls,
        costUsd: toUsd(r.cost_microcents),
      })),
      perOperationType: opTypeRows.map((r) => ({
        operationType: r.operation_type,
        calls: r.calls,
        costUsd: toUsd(r.cost_microcents),
      })),
      perPlugin: pluginRows.map((r) => ({
        pluginId: r.plugin_id,
        pluginSlug: r.plugin_slug,
        calls: r.calls,
        costUsd: toUsd(r.cost_microcents),
      })),
      perAttribution: await buildAttribution(tx, since),
    });
  },
});

/**
 * P16 hardening — three-way attribution roll-up. Each ai_calls row is
 * attributed to ONE of: a plugin (when plugin_id IS NOT NULL), a
 * subagent (when parent_chat_session_id IS NOT NULL), or the human
 * user behind the chat session (joined via chat_sessions → actors →
 * users). System actor calls fall into a `system` bucket.
 */
async function buildAttribution(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  since: string,
): Promise<
  Array<{
    kind: "plugin" | "user" | "subagent" | "system";
    label: string;
    calls: number;
    costUsd: number;
  }>
> {
  const rows = (await tx.execute(sql`
    SELECT
      CASE
        WHEN c.plugin_id IS NOT NULL THEN 'plugin'
        WHEN c.parent_chat_session_id IS NOT NULL THEN 'subagent'
        WHEN u.email IS NOT NULL THEN 'user'
        ELSE 'system'
      END AS kind,
      COALESCE(p.slug, u.email, c.parent_chat_session_id::text, 'system') AS label,
      COUNT(*)::int AS calls,
      COALESCE(SUM(c.cost_estimate_microcents), 0)::bigint AS cost_microcents
    FROM ai_calls c
    LEFT JOIN plugins p ON p.id = c.plugin_id
    LEFT JOIN chat_sessions s ON s.id = c.chat_session_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE c.created_at >= ${since}
    GROUP BY 1, 2
    ORDER BY cost_microcents DESC
    LIMIT 50
  `)) as unknown as Array<{
    kind: "plugin" | "user" | "subagent" | "system";
    label: string;
    calls: number;
    cost_microcents: bigint | string | number;
  }>;
  const toUsd = (v: bigint | string | number): number => {
    const n =
      typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number.parseInt(v, 10) : v;
    return n / 1e8;
  };
  return rows.map((r) => ({
    kind: r.kind,
    label: r.label,
    calls: r.calls,
    costUsd: toUsd(r.cost_microcents),
  }));
}

/**
 * P11.6 — per-plugin AI spend rollup. The plugin-host's ctx.ai.complete
 * checks this on each invocation before dispatching to the provider;
 * if (last 24h sum) ≥ ai_cost_cap_microcents the call fails with a
 * structured error and the plugin's operation surfaces it. The
 * /security/plugins/[slug] page calls this to render the "AI spend
 * (last 24h)" cell + cap status.
 *
 * Open read — Owner UI consumes; AI may also call to check before a
 * potentially expensive batch op ("am I about to blow the budget?").
 */
export const aggregatePluginAiSpendOp = defineOperation({
  name: "ai_calls.aggregate_per_plugin",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pluginId: z.string().uuid() }).strict(),
  output: z.object({
    pluginId: z.string(),
    capMicrocents: z.number().nullable(),
    last24hMicrocents: z.number().int().nonnegative(),
    last24hCalls: z.number().int().nonnegative(),
    capPct: z.number().min(0).nullable(),
    capExceeded: z.boolean(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        p.ai_cost_cap_microcents AS cap,
        COALESCE(SUM(c.cost_estimate_microcents) FILTER (
          WHERE c.created_at > now() - interval '24 hours'
        ), 0)::bigint AS spent,
        COUNT(c.id) FILTER (
          WHERE c.created_at > now() - interval '24 hours'
        )::int AS calls
      FROM plugins p
      LEFT JOIN ai_calls c ON c.plugin_id = p.id
      WHERE p.id = ${input.pluginId}::uuid
      GROUP BY p.id, p.ai_cost_cap_microcents
    `)) as unknown as {
      cap: number | string | bigint | null;
      spent: number | string | bigint;
      calls: number;
    }[];
    const r = rows[0];
    if (!r) {
      return ok({
        pluginId: input.pluginId,
        capMicrocents: null,
        last24hMicrocents: 0,
        last24hCalls: 0,
        capPct: null,
        capExceeded: false,
      });
    }
    const cap =
      r.cap === null
        ? null
        : typeof r.cap === "bigint"
          ? Number(r.cap)
          : typeof r.cap === "string"
            ? Number.parseInt(r.cap, 10)
            : r.cap;
    const spent =
      typeof r.spent === "bigint"
        ? Number(r.spent)
        : typeof r.spent === "string"
          ? Number.parseInt(r.spent, 10)
          : r.spent;
    return ok({
      pluginId: input.pluginId,
      capMicrocents: cap,
      last24hMicrocents: spent,
      last24hCalls: r.calls,
      capPct: cap && cap > 0 ? Math.min(1, spent / cap) : null,
      capExceeded: cap !== null && spent >= cap,
    });
  },
});

/**
 * P11.6 — Owner-only setter for the per-plugin AI spend cap. NULL =
 * uncapped (default). Microcents (×1e-8 USD) for consistency with
 * ai_calls.cost_estimate_microcents.
 */
export const setPluginAiCostCapOp = defineOperation({
  name: "plugins.set_ai_cost_cap",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      pluginId: z.string().uuid(),
      capMicrocents: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE plugins
         SET ai_cost_cap_microcents = ${input.capMicrocents}
       WHERE id = ${input.pluginId}::uuid
    `);
    return ok({});
  },
});
