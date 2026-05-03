// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — ai_budgets ops + budget-status query.
 *
 * Six rows max: 3 scopes (session / day-global / day-per-actor) × 2
 * operation_types (text / image). NULL cap = unlimited. warn_at_pct
 * surfaces a soft warning in chat-runner before blocking; default 0.80.
 *
 * Text and image budgets enforce INDEPENDENTLY — exhausting the image
 * cap never blocks text generation in the same chat session.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";

const budgetRow = z.object({
  scope: z.enum(["session", "day-global", "day-per-actor"]),
  operationType: z.enum(["text", "image"]),
  capMicrocents: z.number().int().nonnegative().nullable(),
  warnAtPct: z.number().min(0).max(1),
  updatedAt: z.string(),
});

export const listAiBudgetsOp = defineOperation({
  name: "ai_budgets.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ rows: z.array(budgetRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT scope, operation_type, cap_microcents, warn_at_pct, updated_at
      FROM ai_budgets
      ORDER BY scope, operation_type
    `)) as unknown as Array<{
      scope: "session" | "day-global" | "day-per-actor";
      operation_type: "text" | "image";
      cap_microcents: bigint | string | number | null;
      warn_at_pct: string | number;
      updated_at: string | Date;
    }>;
    const toN = (v: bigint | string | number | null): number | null =>
      v === null
        ? null
        : typeof v === "bigint"
          ? Number(v)
          : typeof v === "string"
            ? Number.parseInt(v, 10)
            : v;
    return ok({
      rows: rows.map((r) => ({
        scope: r.scope,
        operationType: r.operation_type,
        capMicrocents: toN(r.cap_microcents),
        warnAtPct:
          typeof r.warn_at_pct === "string" ? Number.parseFloat(r.warn_at_pct) : r.warn_at_pct,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      })),
    });
  },
});

export const setAiBudgetOp = defineOperation({
  name: "ai_budgets.set",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      scope: z.enum(["session", "day-global", "day-per-actor"]),
      operationType: z.enum(["text", "image"]),
      capMicrocents: z.number().int().nonnegative().nullable(),
      warnAtPct: z.number().min(0).max(1).default(0.8),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO ai_budgets (scope, operation_type, cap_microcents, warn_at_pct, updated_at)
      VALUES (${input.scope}, ${input.operationType}, ${input.capMicrocents}, ${input.warnAtPct}, now())
      ON CONFLICT (scope, operation_type) DO UPDATE
        SET cap_microcents = EXCLUDED.cap_microcents,
            warn_at_pct = EXCLUDED.warn_at_pct,
            updated_at = now()
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "ai_budgets.set",
      input,
      succeeded: true,
      resultSummary: `${input.scope}/${input.operationType} cap=${input.capMicrocents ?? "unlimited"}`,
    });
    return ok({});
  },
});

const statusRow = z.object({
  scope: z.enum(["session", "day-global", "day-per-actor"]),
  operationType: z.enum(["text", "image"]),
  capMicrocents: z.number().int().nonnegative().nullable(),
  // NULL for session scope — chat-runner tracks per-session spend in
  // chat_sessions.cost_estimate_microcents, which this op can't see
  // without a sessionId. UI renders NULL as "—" for session rows so
  // operators don't misread it as "$0 spent."
  spentMicrocents: z.number().int().nonnegative().nullable(),
  pct: z.number().min(0).nullable(),
  status: z.enum(["ok", "warn", "blocked", "unknown"]),
});

/**
 * Live budget status. Chat-runner consults before every provider call;
 * the cost dashboard surfaces. day-global rolls up all actors;
 * day-per-actor filters by `ctx.actorId`. session-scope is left at NULL
 * spent in this op because the chat-runner already tracks session spend
 * via `chat_sessions.cost_estimate_microcents` — included here as a
 * row with spent=0 + pct=null so the UI can render the row label.
 */
export const aiBudgetsStatusOp = defineOperation({
  name: "ai_budgets.status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      operationType: z.enum(["text", "image"]).optional(),
    })
    .strict(),
  output: z.object({ rows: z.array(statusRow) }),
  handler: async (ctx, input, tx) => {
    const filterOp = input.operationType
      ? sql`AND operation_type = ${input.operationType}`
      : sql.raw("");
    const budgets = (await tx.execute(sql`
      SELECT scope, operation_type, cap_microcents, warn_at_pct
      FROM ai_budgets
      WHERE 1=1 ${filterOp}
      ORDER BY scope, operation_type
    `)) as unknown as Array<{
      scope: "session" | "day-global" | "day-per-actor";
      operation_type: "text" | "image";
      cap_microcents: bigint | string | number | null;
      warn_at_pct: string | number;
    }>;
    if (budgets.length === 0) return ok({ rows: [] });

    const dayGlobal = (await tx.execute(sql`
      SELECT operation_type,
        COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS spent
      FROM ai_calls
      WHERE created_at > now() - interval '24 hours'
      GROUP BY operation_type
    `)) as unknown as Array<{ operation_type: "text" | "image"; spent: bigint | string | number }>;
    const dayPerActor = (await tx.execute(sql`
      SELECT operation_type,
        COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS spent
      FROM ai_calls
      WHERE created_at > now() - interval '24 hours'
        AND actor_id = ${ctx.actorId}::uuid
      GROUP BY operation_type
    `)) as unknown as Array<{ operation_type: "text" | "image"; spent: bigint | string | number }>;

    const toN = (v: bigint | string | number): number =>
      typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number.parseInt(v, 10) : v;
    const dgMap = new Map(dayGlobal.map((r) => [r.operation_type, toN(r.spent)]));
    const dpaMap = new Map(dayPerActor.map((r) => [r.operation_type, toN(r.spent)]));

    return ok({
      rows: budgets.map((b) => {
        const cap = b.cap_microcents === null ? null : toN(b.cap_microcents);
        const warnPct =
          typeof b.warn_at_pct === "string" ? Number.parseFloat(b.warn_at_pct) : b.warn_at_pct;
        // Session scope can't be computed here — caller would need to
        // pass sessionId. Return null spent + 'unknown' status so the
        // UI renders "—" instead of misleading "$0 spent".
        const spent: number | null =
          b.scope === "day-global"
            ? (dgMap.get(b.operation_type) ?? 0)
            : b.scope === "day-per-actor"
              ? (dpaMap.get(b.operation_type) ?? 0)
              : null;
        const pct = cap && cap > 0 && spent !== null ? Math.min(2, spent / cap) : null;
        const status: "ok" | "warn" | "blocked" | "unknown" =
          spent === null
            ? "unknown"
            : cap === null
              ? "ok"
              : spent >= cap
                ? "blocked"
                : pct !== null && pct >= warnPct
                  ? "warn"
                  : "ok";
        return {
          scope: b.scope,
          operationType: b.operation_type,
          capMicrocents: cap,
          spentMicrocents: spent,
          pct,
          status,
        };
      }),
    });
  },
});
