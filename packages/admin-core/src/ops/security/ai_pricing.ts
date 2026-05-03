// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — ai_pricing ops. Pricing table is operator-editable so a provider
 * rate change doesn't need a code redeploy. Historical rows kept; the
 * lookup picks the row with the largest `effective_from <= now()`
 * matching (provider, model, operation_type).
 *
 * recordAiCall reads from this table to compute cost_estimate_microcents
 * at insert time (P16 PR2 wires that swap inside chat-runner +
 * generate-image tool).
 */

import { defineOperation } from "@caelo/query-api";
import { ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { invalidatePricingEntry } from "../../ai/pricing-cache.js";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";

const pricingRow = z.object({
  provider: z.string(),
  model: z.string(),
  operationType: z.enum(["text", "image"]),
  inputMicrocents: z.number().int().nonnegative(),
  outputMicrocents: z.number().int().nonnegative().nullable(),
  cachedMicrocents: z.number().int().nonnegative().nullable(),
  effectiveFrom: z.string(),
});

export const listAiPricingOp = defineOperation({
  name: "ai_pricing.list",
  // Open read so AI can answer "what does Mode 2 translation cost on Gemini?"
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ rows: z.array(pricingRow) }),
  handler: async (_ctx, _input, tx) => {
    // Latest effective_from per (provider, model, operation_type).
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (provider, model, operation_type)
        provider, model, operation_type,
        input_microcents, output_microcents, cached_microcents,
        effective_from
      FROM ai_pricing
      WHERE effective_from <= now()
      ORDER BY provider, model, operation_type, effective_from DESC
    `)) as unknown as Array<{
      provider: string;
      model: string;
      operation_type: "text" | "image";
      input_microcents: bigint | string | number;
      output_microcents: bigint | string | number | null;
      cached_microcents: bigint | string | number | null;
      effective_from: string | Date;
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
        provider: r.provider,
        model: r.model,
        operationType: r.operation_type,
        inputMicrocents: toN(r.input_microcents) ?? 0,
        outputMicrocents: toN(r.output_microcents),
        cachedMicrocents: toN(r.cached_microcents),
        effectiveFrom:
          r.effective_from instanceof Date
            ? r.effective_from.toISOString()
            : String(r.effective_from),
      })),
    });
  },
});

export const setAiPricingOp = defineOperation({
  name: "ai_pricing.set",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      provider: z.string().min(1).max(50),
      model: z.string().min(1).max(100),
      operationType: z.enum(["text", "image"]),
      inputMicrocents: z.number().int().nonnegative(),
      outputMicrocents: z.number().int().nonnegative().nullable(),
      cachedMicrocents: z.number().int().nonnegative().nullable(),
      effectiveFrom: z.string().datetime().optional(),
    })
    .strict(),
  output: z.object({ inserted: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const ts = input.effectiveFrom ?? new Date().toISOString();
    await tx.execute(sql`
      INSERT INTO ai_pricing
        (provider, model, operation_type, input_microcents, output_microcents, cached_microcents, effective_from)
      VALUES
        (${input.provider}, ${input.model}, ${input.operationType},
         ${input.inputMicrocents}, ${input.outputMicrocents}, ${input.cachedMicrocents},
         ${ts}::timestamptz)
      ON CONFLICT (provider, model, operation_type, effective_from) DO UPDATE
        SET input_microcents = EXCLUDED.input_microcents,
            output_microcents = EXCLUDED.output_microcents,
            cached_microcents = EXCLUDED.cached_microcents
    `);
    // P16 hardening — invalidate the per-process pricing LRU on every
    // node listening to channel `caelo_ai_pricing`. Payload is the
    // composite key so each receiver only invalidates the affected entry.
    await tx.execute(sql`
      SELECT pg_notify('caelo_ai_pricing',
        ${`${input.provider}::${input.model}::${input.operationType}`})
    `);
    invalidatePricingEntry(input.provider, input.model, input.operationType);
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "ai_pricing.set",
      input: { provider: input.provider, model: input.model, operationType: input.operationType },
      succeeded: true,
      resultSummary: `effective ${ts}`,
    });
    return ok({ inserted: true });
  },
});
