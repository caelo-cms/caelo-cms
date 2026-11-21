// SPDX-License-Identifier: MPL-2.0

/**
 * #1653 — the AI spend ledger's operations: every paid text call reserves
 * its worst-case cost before it reaches the provider and settles after it
 * (plugin-host ai-ledger.ts holds the ledger; this module prices).
 *
 *   ai_ledger.reserve  worst case of the first request → a reserved ai_calls row
 *   ai_ledger.extend   a multi-step call: spent so far + the next request's worst case
 *   ai_ledger.settle   the real tokens and cost
 *   ai_ledger.release  the call failed before the provider billed anything
 *
 * A refusal is an error with `refusal: true` and a message that names the
 * budget, the figures and the next step. An unpriced model may run only
 * while no cap applies to the call: a cap cannot protect against a cost it
 * cannot see.
 */

import {
  type AiSpender,
  describeAiCapRefusal,
  extendAiSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "@caelo-cms/plugin-host";
import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { computeAiCallCostMicrocents, err, ok, worstCaseTextMicrocents } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { lookupPricing } from "../../ai/pricing-cache.js";

/** An id: any 8-4-4-4-12 hex form (the system actor's id is no RFC 4122 version). */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const tokens = z.number().int().nonnegative();

/** Who pays, as the ledger's callers name it. */
export const aiSpenderInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("actor"),
      actorId: uuid,
      chatSessionId: uuid.nullable(),
      parentChatSessionId: uuid.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plugin"),
      pluginId: uuid,
      actorId: uuid,
      chatSessionId: uuid.nullable(),
    })
    .strict(),
]);

const requestInput = z
  .object({
    /** An upper bound of the request's prompt tokens (call-cost.ts promptTokenBound). */
    promptTokens: tokens,
    maxOutputTokens: tokens,
  })
  .strict();

const usageInput = z
  .object({
    inputTokens: tokens,
    outputTokens: tokens,
    cachedTokens: tokens.default(0),
    cacheCreationTokens: tokens.default(0),
    /** The longest single prompt among the requests (prompt-length pricing). */
    largestPromptTokens: tokens.optional(),
  })
  .strict();

function refuse(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message, refusal: true as const });
}

/** Whether any cap bounds this spender's text calls (an unpriced model may then not run). */
async function capsApply(tx: TransactionRunner, spender: AiSpender): Promise<boolean> {
  const budgets = (await tx.execute(sql`
    SELECT 1 FROM ai_budgets WHERE operation_type = 'text' AND cap_microcents IS NOT NULL LIMIT 1
  `)) as unknown as unknown[];
  if (budgets.length > 0) return true;
  if (spender.kind === "plugin") {
    const cap = (await tx.execute(sql`
      SELECT 1 FROM plugins WHERE id = ${spender.pluginId}::uuid AND ai_cost_cap_microcents IS NOT NULL
    `)) as unknown as unknown[];
    return cap.length > 0;
  }
  return false;
}

/** The worst case of one request, or the unpriced refusal (null amount = may run uncounted). */
async function worstCase(
  tx: TransactionRunner,
  op: string,
  spender: AiSpender,
  provider: string,
  model: string,
  request: z.infer<typeof requestInput>,
): Promise<{ ok: true; amount: number } | { ok: false; message: string }> {
  const pricing = await lookupPricing(tx, provider, model, "text");
  const amount = worstCaseTextMicrocents(pricing, request);
  if (amount !== null) return { ok: true, amount };
  if (await capsApply(tx, spender)) {
    return {
      ok: false,
      message: `${op}: AiModelUnpriced: the model "${model}" (${provider}) has no price, so a spend cap cannot count this call and it does not run. Add the model in Settings → AI → Pricing (the AI can propose it with propose_set_ai_pricing).`,
    };
  }
  console.error("[ai_ledger] no ai_pricing row — the call runs uncounted", { provider, model });
  return { ok: true, amount: 0 };
}

export const aiLedgerReserveOp = defineOperation({
  name: "ai_ledger.reserve",
  readScope: "request",
  // Why system-only: the host's plumbing around each provider call; the
  // actor it charges is in the input, never chosen by the AI.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      spender: aiSpenderInput,
      provider: z.string().min(1).max(100),
      model: z.string().min(1).max(200),
      request: requestInput,
      /** Names the call in the refusal ("this chat step"). */
      what: z.string().min(1).max(200),
      requestId: z.string().max(64).nullable().optional(),
      parentAiCallId: uuid.nullable().optional(),
    })
    .strict(),
  output: z.object({ callId: z.string(), reservedMicrocents: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    const op = "ai_ledger.reserve";
    const spender = input.spender as AiSpender;
    const worst = await worstCase(tx, op, spender, input.provider, input.model, input.request);
    if (!worst.ok) return refuse(op, worst.message);
    const r = await reserveAiSpend(tx, {
      spender,
      operationType: "text",
      provider: input.provider,
      model: input.model,
      amountMicrocents: worst.amount,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.parentAiCallId !== undefined ? { parentAiCallId: input.parentAiCallId } : {}),
    });
    if ("refused" in r) return refuse(op, describeAiCapRefusal(r.refused, input.what));
    return ok({ callId: r.callId, reservedMicrocents: worst.amount });
  },
});

export const aiLedgerExtendOp = defineOperation({
  name: "ai_ledger.extend",
  readScope: "request",
  // Why system-only: see ai_ledger.reserve.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      callId: uuid,
      spender: aiSpenderInput,
      provider: z.string().min(1).max(100),
      model: z.string().min(1).max(200),
      /** What the call's finished requests spent. */
      used: usageInput,
      /** The next request. */
      next: requestInput,
      what: z.string().min(1).max(200),
    })
    .strict(),
  output: z.object({ reservedMicrocents: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    const op = "ai_ledger.extend";
    const spender = input.spender as AiSpender;
    const pricing = await lookupPricing(tx, input.provider, input.model, "text");
    const spent = computeAiCallCostMicrocents(pricing, {
      operationType: "text",
      ...input.used,
      imageCount: 0,
    }).costMicrocents;
    const worst = await worstCase(tx, op, spender, input.provider, input.model, input.next);
    if (!worst.ok) return refuse(op, worst.message);
    const amount = spent + worst.amount;
    const r = await extendAiSpend(tx, input.callId, amount);
    if ("refused" in r) return refuse(op, describeAiCapRefusal(r.refused, input.what));
    if ("gone" in r)
      return refuse(op, `${op}: the reservation ${input.callId} is no longer running`);
    return ok({ reservedMicrocents: amount });
  },
});

export const aiLedgerSettleOp = defineOperation({
  name: "ai_ledger.settle",
  readScope: "request",
  // Why system-only: see ai_ledger.reserve.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      callId: uuid,
      provider: z.string().min(1).max(100),
      model: z.string().min(1).max(200),
      usage: usageInput,
      durationMs: z.number().int().nonnegative(),
      succeeded: z.boolean(),
    })
    .strict(),
  output: z.object({ costMicrocents: z.number().int(), settled: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const u = input.usage;
    // Nothing came back and nothing was billed: the reservation goes.
    if (!input.succeeded && u.inputTokens + u.outputTokens === 0) {
      const released = await releaseAiSpend(tx, input.callId);
      return ok({ costMicrocents: 0, settled: released });
    }
    const pricing = await lookupPricing(tx, input.provider, input.model, "text");
    const mapped = computeAiCallCostMicrocents(pricing, {
      operationType: "text",
      ...u,
      imageCount: 0,
    });
    if (mapped.unpriced) {
      console.error("[ai_ledger] no ai_pricing row — cost recorded as 0 (understated)", {
        provider: input.provider,
        model: input.model,
      });
    }
    const settled = await settleAiSpend(tx, input.callId, {
      provider: input.provider,
      model: input.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedTokens: u.cachedTokens,
      cacheCreationTokens: u.cacheCreationTokens,
      costMicrocents: mapped.costMicrocents,
      durationMs: input.durationMs,
      succeeded: input.succeeded,
    });
    return ok({ costMicrocents: mapped.costMicrocents, settled });
  },
});

export const aiLedgerReleaseOp = defineOperation({
  name: "ai_ledger.release",
  readScope: "request",
  // Why system-only: see ai_ledger.reserve.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ callId: uuid }).strict(),
  output: z.object({ released: z.boolean() }),
  handler: async (_ctx, input, tx) => ok({ released: await releaseAiSpend(tx, input.callId) }),
});

/** The ledger's ops, for register.ts. */
export const AI_LEDGER_OPS = [
  aiLedgerReserveOp,
  aiLedgerExtendOp,
  aiLedgerSettleOp,
  aiLedgerReleaseOp,
] as const;
