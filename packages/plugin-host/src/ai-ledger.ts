// SPDX-License-Identifier: MPL-2.0

/**
 * The one AI spend ledger (#1653): every paid AI call — a chat turn's
 * steps, a subagent, a core helper (moduleize, the completeness judge,
 * selector picking), a plugin's `ctx.ai`, an image — reserves its
 * worst-case cost before it reaches the provider, and settles to the real
 * cost after it.
 *
 * A reservation is an `ai_calls` row (`reservation = 'reserved'`) at the
 * worst-case cost, so every sum that reads `ai_calls` — the budgets, the
 * plugin cap, the cost dashboard — sees calls that are still running.
 * Settling writes the real tokens and cost (`'settled'`); a call that
 * failed before the provider billed anything is released (`'released'`,
 * cost 0). A multi-step chat turn keeps one row and extends it before each
 * further step (what it spent so far plus the next step's worst case).
 *
 * Every reservation and extension runs under one advisory lock, so two
 * concurrent calls can never both pass a cap that only one of them fits
 * under. The caps a call is checked against depend on who spends:
 *
 *   - `actor`         a person's work (chat, subagents, core AI helpers):
 *                     the day-global, day-per-actor and session budgets;
 *   - `plugin`        a plugin's `ctx.ai` / images: the same budgets for the
 *                     person it acts for, plus the plugin's own cap.
 *
 * Visitors' AI conversations (#1654) are not in this ledger: they run in
 * the public gateway, which has no cms_admin login, on a key and budgets of
 * their own, and the gateway keeps their ledger in cms_public with the
 * same pricing (@caelo-cms/shared ai-cost.ts, docs/dev/visitor-ai.md).
 *
 * It lives in plugin-host because admin-core depends on plugin-host, not
 * the other way round: the image ledger (image-ledger.ts) and admin-core's
 * `ai_ledger.*` operations both build on it. The functions run inside the
 * calling operation's transaction.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** The one lock every reservation, of any kind, serialises on. */
export const AI_LEDGER_LOCK = sql`SELECT pg_advisory_xact_lock(220, 1)`;

/** Who pays for a call; decides which caps apply. */
export type AiSpender =
  | {
      readonly kind: "actor";
      /** The person the work is for (budgets per actor). */
      readonly actorId: string;
      /** The chat session the call belongs to, when there is one. */
      readonly chatSessionId: string | null;
      /** A subagent's parent session: the session budget counts the whole chat. */
      readonly parentChatSessionId?: string | null;
    }
  | {
      readonly kind: "plugin";
      readonly pluginId: string;
      /** The person the plugin acts for, or the system actor (workers, observers). */
      readonly actorId: string;
      readonly chatSessionId: string | null;
    };

/** Per-session budgets: the chat session, or (plugin images) a request tag. */
export type AiSessionKey = { readonly chatSessionId: string } | { readonly tag: string } | null;

/** Why a call may not start. */
export type AiCapRefusal =
  | {
      readonly kind: "budget";
      readonly scope: "session" | "day-global" | "day-per-actor";
      readonly operationType: "text" | "image";
      readonly capMicrocents: number;
      readonly spentMicrocents: number;
      readonly requestedMicrocents: number;
    }
  | {
      readonly kind: "plugin-budget";
      readonly capMicrocents: number;
      readonly spentMicrocents: number;
      readonly requestedMicrocents: number;
    }
  /** A per-session cap is set and the call has no session to count against. */
  | { readonly kind: "session-required"; readonly operationType: "text" | "image" };

function sessionKeyOf(spender: AiSpender): AiSessionKey {
  const session =
    spender.kind === "actor"
      ? (spender.parentChatSessionId ?? spender.chatSessionId)
      : spender.chatSessionId;
  return session ? { chatSessionId: session } : null;
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Checks every cap that applies to `spender` for a call of `amount`
 * microcents. Call under {@link AI_LEDGER_LOCK}; `excludeCallId` leaves out
 * the row being extended (its new amount replaces its old one).
 *
 * @param opts.session overrides the session key (plugin images count a
 *   chat branch tag); `requireSession` refuses when a session cap is set
 *   and the call has none (images); text without a session skips that cap.
 */
export async function checkAiCaps(
  tx: TransactionRunner,
  opts: {
    readonly spender: AiSpender;
    readonly operationType: "text" | "image";
    readonly amountMicrocents: number;
    readonly excludeCallId?: string;
    readonly session?: AiSessionKey;
    readonly requireSession?: boolean;
  },
): Promise<AiCapRefusal | null> {
  const { spender, operationType } = opts;
  const amount = opts.amountMicrocents;
  const exclude = opts.excludeCallId ? sql`AND id <> ${opts.excludeCallId}::uuid` : sql``;
  const session = opts.session !== undefined ? opts.session : sessionKeyOf(spender);
  const budgets = (await tx.execute(sql`
    SELECT scope, cap_microcents FROM ai_budgets
    WHERE operation_type = ${operationType} AND cap_microcents IS NOT NULL
    ORDER BY scope
  `)) as unknown as { scope: "session" | "day-global" | "day-per-actor"; cap_microcents: string }[];
  for (const budget of budgets) {
    let filter: ReturnType<typeof sql>;
    if (budget.scope === "day-global") {
      filter = sql`created_at > now() - interval '24 hours'`;
    } else if (budget.scope === "day-per-actor") {
      filter = sql`created_at > now() - interval '24 hours' AND actor_id = ${spender.actorId}::uuid`;
    } else if (session && "chatSessionId" in session) {
      filter = sql`(chat_session_id = ${session.chatSessionId}::uuid OR parent_chat_session_id = ${session.chatSessionId}::uuid)`;
    } else if (session && "tag" in session) {
      filter = sql`request_id = ${session.tag}`;
    } else {
      if (opts.requireSession) return { kind: "session-required", operationType };
      continue;
    }
    const usage = (await tx.execute(sql`
      SELECT coalesce(sum(cost_estimate_microcents), 0)::bigint AS spent FROM ai_calls
      WHERE operation_type = ${operationType} AND ${filter} ${exclude}
    `)) as unknown as { spent: string }[];
    const spent = num(usage[0]?.spent);
    const cap = num(budget.cap_microcents);
    if (spent + amount > cap) {
      return {
        kind: "budget",
        scope: budget.scope,
        operationType,
        capMicrocents: cap,
        spentMicrocents: spent,
        requestedMicrocents: amount,
      };
    }
  }
  if (spender.kind !== "actor") {
    const plugin = (await tx.execute(sql`
      SELECT ai_cost_cap_microcents AS cap FROM plugins WHERE id = ${spender.pluginId}::uuid
    `)) as unknown as { cap: string | null }[];
    const cap = plugin[0]?.cap;
    if (cap !== null && cap !== undefined) {
      const usage = (await tx.execute(sql`
        SELECT coalesce(sum(cost_estimate_microcents), 0)::bigint AS spent FROM ai_calls
        WHERE plugin_id = ${spender.pluginId}::uuid AND created_at > now() - interval '24 hours' ${exclude}
      `)) as unknown as { spent: string }[];
      const spent = num(usage[0]?.spent);
      if (spent + amount > num(cap)) {
        return {
          kind: "plugin-budget",
          capMicrocents: num(cap),
          spentMicrocents: spent,
          requestedMicrocents: amount,
        };
      }
    }
  }
  return null;
}

/** What a new reservation records. */
export interface AiReservation {
  readonly spender: AiSpender;
  readonly operationType: "text" | "image";
  readonly provider: string;
  readonly model: string;
  /** The worst-case cost of the call. */
  readonly amountMicrocents: number;
  readonly requestId?: string | null;
  readonly parentAiCallId?: string | null;
  /** Images: refuse when a session cap is set and the call has no session. */
  readonly requireSession?: boolean;
  /** Images: the session key, when it is not the chat session. */
  readonly session?: AiSessionKey;
}

function chatSessionOf(spender: AiSpender): string | null {
  return spender.chatSessionId;
}

/**
 * Reserves `amountMicrocents` against every cap for the spender. Returns the
 * reservation's `ai_calls` id, or why the call may not start. Takes the
 * ledger lock itself; callers that check more under the same lock (the
 * image ledger) take it first — the lock is re-entrant in one transaction.
 */
export async function reserveAiSpend(
  tx: TransactionRunner,
  input: AiReservation,
): Promise<{ readonly callId: string } | { readonly refused: AiCapRefusal }> {
  await tx.execute(AI_LEDGER_LOCK);
  const refused = await checkAiCaps(tx, {
    spender: input.spender,
    operationType: input.operationType,
    amountMicrocents: input.amountMicrocents,
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.requireSession ? { requireSession: true } : {}),
  });
  if (refused) return { refused };
  const callId = crypto.randomUUID();
  const s = input.spender;
  await tx.execute(sql`
    INSERT INTO ai_calls (id, actor_id, plugin_id, chat_session_id, parent_chat_session_id,
      parent_ai_call_id, provider, model, input_tokens, output_tokens, cached_tokens,
      cost_estimate_microcents, succeeded, operation_type, image_count, request_id,
      spender, reservation)
    VALUES (${callId}::uuid, ${s.actorId}::uuid, ${s.kind === "actor" ? null : s.pluginId}::uuid,
      ${chatSessionOf(s)}::uuid,
      ${s.kind === "actor" ? (s.parentChatSessionId ?? null) : null}::uuid,
      ${input.parentAiCallId ?? null}::uuid, ${input.provider}, ${input.model}, 0, 0, 0,
      ${input.amountMicrocents}, false, ${input.operationType},
      ${input.operationType === "image" ? 1 : 0}, ${input.requestId ?? null},
      ${s.kind}, 'reserved')
  `);
  return { callId };
}

/** A reservation as the ledger keeps it. */
interface ReservedRow {
  readonly spender: AiSpender["kind"];
  readonly actor_id: string;
  readonly plugin_id: string | null;
  readonly chat_session_id: string | null;
  readonly parent_chat_session_id: string | null;
  readonly operation_type: "text" | "image";
  readonly reservation: "reserved" | "settled" | "released";
}

async function readReservation(tx: TransactionRunner, callId: string): Promise<ReservedRow | null> {
  const rows = (await tx.execute(sql`
    SELECT spender, actor_id::text AS actor_id, plugin_id::text AS plugin_id,
           chat_session_id::text AS chat_session_id,
           parent_chat_session_id::text AS parent_chat_session_id, operation_type, reservation
    FROM ai_calls WHERE id = ${callId}::uuid
  `)) as unknown as ReservedRow[];
  return rows[0] ?? null;
}

/**
 * Moves a running reservation to `amountMicrocents` (what a multi-step call
 * spent so far plus its next step's worst case), checked against the same
 * caps with this row left out. A row that is no longer reserved is refused.
 */
export async function extendAiSpend(
  tx: TransactionRunner,
  callId: string,
  amountMicrocents: number,
): Promise<{ readonly ok: true } | { readonly refused: AiCapRefusal } | { readonly gone: true }> {
  await tx.execute(AI_LEDGER_LOCK);
  const row = await readReservation(tx, callId);
  if (row?.reservation !== "reserved") return { gone: true };
  const spender: AiSpender =
    row.spender === "actor"
      ? {
          kind: "actor",
          actorId: row.actor_id,
          chatSessionId: row.chat_session_id,
          parentChatSessionId: row.parent_chat_session_id,
        }
      : {
          kind: "plugin",
          pluginId: row.plugin_id as string,
          actorId: row.actor_id,
          chatSessionId: row.chat_session_id,
        };
  const refused = await checkAiCaps(tx, {
    spender,
    operationType: row.operation_type,
    amountMicrocents,
    excludeCallId: callId,
  });
  if (refused) return { refused };
  await tx.execute(sql`
    UPDATE ai_calls SET cost_estimate_microcents = ${amountMicrocents}
    WHERE id = ${callId}::uuid AND reservation = 'reserved'
  `);
  return { ok: true };
}

/** The real outcome of a reserved call. */
export interface AiSettlement {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly cacheCreationTokens: number;
  readonly costMicrocents: number;
  readonly durationMs: number;
  readonly succeeded: boolean;
  /**
   * A request of the call went out and its usage never came back, and
   * nothing proves the provider billed nothing (`failureProvedUnbilled`):
   * the call is booked at least at its reservation, which holds that
   * request's worst case.
   */
  readonly usageMissing: boolean;
}

/**
 * Settles a reservation at its real cost, or at least at the reservation
 * when usage is missing. Returns what was booked, null when the row was no
 * longer reserved. Idempotent: a settled or released row stays.
 */
export async function settleAiSpend(
  tx: TransactionRunner,
  callId: string,
  s: AiSettlement,
): Promise<number | null> {
  const [row] = (await tx.execute(sql`
    UPDATE ai_calls SET provider = ${s.provider}, model = ${s.model},
      input_tokens = ${s.inputTokens}, output_tokens = ${s.outputTokens},
      cached_tokens = ${s.cachedTokens}, cache_creation_tokens = ${s.cacheCreationTokens},
      cost_estimate_microcents = CASE WHEN ${s.usageMissing}
        THEN GREATEST(cost_estimate_microcents, ${s.costMicrocents}) ELSE ${s.costMicrocents} END,
      duration_ms = ${s.durationMs}, succeeded = ${s.succeeded}, reservation = 'settled'
    WHERE id = ${callId}::uuid AND reservation = 'reserved'
    RETURNING cost_estimate_microcents::bigint AS cost
  `)) as unknown as { cost: string | number }[];
  return row ? Number(row.cost) : null;
}

/** Releases a reservation whose call provably billed nothing (`failureProvedUnbilled`). */
export async function releaseAiSpend(tx: TransactionRunner, callId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    UPDATE ai_calls SET cost_estimate_microcents = 0, succeeded = false, reservation = 'released'
    WHERE id = ${callId}::uuid AND reservation = 'reserved'
    RETURNING id
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Dollars; amounts below a cent keep four decimals so a small cap does not read "$0.00". */
const usd = (microcents: number): string =>
  `$${(microcents / 1e8).toFixed(microcents > 0 && microcents < 1_000_000 ? 4 : 2)}`;

/**
 * The refusal as the person and the AI read it: which budget, how much is
 * spent, what the call could cost, and what to do. `what` names the call
 * ("this chat step", "plugin 'x''s AI call").
 */
export function describeAiCapRefusal(refusal: AiCapRefusal, what: string): string {
  const raise =
    "The Owner can raise it in Settings → AI → Budgets (the AI can propose it with propose_set_ai_budget)";
  switch (refusal.kind) {
    case "budget": {
      const kind = refusal.operationType === "image" ? "image" : "AI text";
      const figures = `${usd(refusal.spentMicrocents)} of ${usd(refusal.capMicrocents)} spent; ${what} could cost up to ${usd(refusal.requestedMicrocents)}`;
      if (refusal.scope === "session")
        return `AiBudgetReached (session): this chat's ${kind} budget is reached (${figures}). Continue in a new chat, or ${raise.charAt(0).toLowerCase()}${raise.slice(1)}.`;
      const who = refusal.scope === "day-global" ? "The site's" : "This person's";
      return `AiBudgetReached (${refusal.scope}): ${who} daily ${kind} budget is reached (${figures} in the last 24 hours). Spend frees up as calls age out of the 24 hours. ${raise}.`;
    }
    case "plugin-budget":
      return `AiBudgetReached (plugin): the plugin's own AI cap is reached (${usd(refusal.spentMicrocents)} of ${usd(refusal.capMicrocents)} in the last 24 hours; ${what} could cost up to ${usd(refusal.requestedMicrocents)}). The Owner can raise it in Settings → Plugins (the AI can propose it with propose_set_plugin_ai_cost_cap).`;
    case "session-required":
      return `AiBudgetReached (session): a per-chat ${refusal.operationType === "image" ? "image" : "AI text"} budget is set, so ${what} runs only inside a chat.`;
  }
}
