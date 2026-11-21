// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor AI's spend ledger in cms_public (#1654, migration 0740
 * `visitor_ai_calls`), written by the gateway.
 *
 * A turn reserves its worst case before any token flows: one `reserved` row
 * at the most the turn can cost (every step's prompt bound at the dearest
 * input lane, every output token the ceiling allows, @caelo-cms/shared
 * `worstCaseTextMicrocents`). The row is settled to the real cost when the
 * turn ends, or released (cost 0) when it failed before the provider
 * answered. A reservation that is never settled (the process died) keeps
 * its worst case and ages out of the windows: overstated, never under.
 *
 * Every reservation takes one advisory lock and checks, under it, every cap
 * against what the ledger holds, running turns at their reservation:
 *
 *   - the rolling 24 hours and 30 days (the Owner's budgets; staging's
 *     database has staging's own),
 *   - the conversation's total, its turn count and whether a turn of it is
 *     still running (a forked or replayed history counts against the same
 *     conversation),
 *   - the turns running site-wide (the concurrent conversations).
 *
 * So concurrent conversations can never pass a budget only one of them
 * fits under. It is the gateway's own bookkeeping, like its rate-limit
 * buckets (middleware/rate-limit.ts): system transactions on its own
 * database, no Query API op, nothing an actor asked for.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-visitor-ai-ledger",
};

/** The one lock every reservation serialises on (distinct from the rate limiter's per-key locks). */
const LEDGER_LOCK = sql`SELECT pg_advisory_xact_lock(220, 1654)`;

/** A running turn older than this no longer counts as running (a turn's deadline is far below it). */
export const OPEN_TURN_WINDOW_SECONDS = 180;

/** The caps one reservation is checked against. */
export interface LedgerCaps {
  readonly dailyMicrocents: number;
  readonly monthlyMicrocents: number;
  readonly conversationMicrocents: number;
  readonly maxConcurrent: number;
  readonly maxTurns: number;
}

/** Why a turn may not start. */
export type LedgerRefusal =
  | { readonly kind: "BudgetExhausted"; readonly scope: "day" | "month" | "conversation" }
  | { readonly kind: "RateLimited"; readonly scope: "concurrent" | "conversation-busy" }
  | { readonly kind: "TooLong"; readonly scope: "turns" };

/**
 * Reserve `amountMicrocents` for one turn of `conversationId`, or say why
 * it may not run.
 */
export async function reserveTurn(
  adapter: DatabaseAdapter,
  turn: {
    readonly pluginId: string;
    readonly operation: string;
    readonly conversationId: string;
    readonly model: string;
    readonly amountMicrocents: number;
    readonly caps: LedgerCaps;
  },
): Promise<
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly refused: LedgerRefusal }
> {
  return adapter.withPublicTransaction(SYSTEM_CTX, async (tx) => {
    await tx.execute(LEDGER_LOCK);
    const amount = sql`CASE WHEN reservation = 'reserved' THEN reserved_microcents ELSE cost_microcents END`;
    const open = sql`reservation = 'reserved' AND created_at > now() - make_interval(secs => ${OPEN_TURN_WINDOW_SECONDS})`;
    const [w] = (await tx.execute(sql`
      SELECT coalesce(sum(${amount}) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS day,
             coalesce(sum(${amount}), 0)::float8 AS month,
             count(*) FILTER (WHERE ${open})::int AS running
      FROM visitor_ai_calls WHERE created_at > now() - interval '30 days'
    `)) as unknown as { day: number; month: number; running: number }[];
    const [c] = (await tx.execute(sql`
      SELECT coalesce(sum(${amount}), 0)::float8 AS spent,
             count(*) FILTER (WHERE reservation <> 'released')::int AS turns,
             count(*) FILTER (WHERE ${open})::int AS running
      FROM visitor_ai_calls WHERE conversation_id = ${turn.conversationId}
    `)) as unknown as { spent: number; turns: number; running: number }[];
    const a = turn.amountMicrocents;
    const refuse = (refused: LedgerRefusal) => ({ ok: false as const, refused });
    if ((c?.running ?? 0) > 0) return refuse({ kind: "RateLimited", scope: "conversation-busy" });
    if ((c?.turns ?? 0) >= turn.caps.maxTurns) return refuse({ kind: "TooLong", scope: "turns" });
    if ((w?.running ?? 0) >= turn.caps.maxConcurrent)
      return refuse({ kind: "RateLimited", scope: "concurrent" });
    if ((w?.day ?? 0) + a > turn.caps.dailyMicrocents)
      return refuse({ kind: "BudgetExhausted", scope: "day" });
    if ((w?.month ?? 0) + a > turn.caps.monthlyMicrocents)
      return refuse({ kind: "BudgetExhausted", scope: "month" });
    if ((c?.spent ?? 0) + a > turn.caps.conversationMicrocents)
      return refuse({ kind: "BudgetExhausted", scope: "conversation" });
    const [row] = (await tx.execute(sql`
      INSERT INTO visitor_ai_calls
        (plugin_id, operation, conversation_id, reservation, reserved_microcents, model)
      VALUES (${turn.pluginId}::uuid, ${turn.operation}, ${turn.conversationId}, 'reserved',
              ${Math.ceil(a)}, ${turn.model})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    if (!row) throw new Error("visitor_ai_calls: the reservation returned no id");
    return { ok: true as const, id: row.id };
  });
}

/** Book a finished turn at its real cost. */
export async function settleTurn(
  adapter: DatabaseAdapter,
  id: string,
  outcome: {
    readonly costMicrocents: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly steps: number;
  },
): Promise<void> {
  await adapter.withPublicTransaction(SYSTEM_CTX, (tx) =>
    tx.execute(sql`
      UPDATE visitor_ai_calls SET reservation = 'settled',
        cost_microcents = ${Math.max(0, Math.ceil(outcome.costMicrocents))},
        input_tokens = ${Math.max(0, Math.round(outcome.inputTokens))},
        output_tokens = ${Math.max(0, Math.round(outcome.outputTokens))},
        steps = ${Math.min(8, Math.max(0, outcome.steps))}, settled_at = now()
      WHERE id = ${id}::uuid AND reservation = 'reserved'
    `),
  );
}

/** Release a turn the provider never answered (it billed nothing). */
export async function releaseTurn(adapter: DatabaseAdapter, id: string): Promise<void> {
  await adapter.withPublicTransaction(SYSTEM_CTX, (tx) =>
    tx.execute(sql`
      UPDATE visitor_ai_calls SET reservation = 'released', cost_microcents = 0, settled_at = now()
      WHERE id = ${id}::uuid AND reservation = 'reserved'
    `),
  );
}
