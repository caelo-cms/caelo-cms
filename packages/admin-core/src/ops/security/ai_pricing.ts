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

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
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
  cacheCreationMicrocents: z.number().int().nonnegative().nullable(),
  effectiveFrom: z.string(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
});

const toIso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

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
        cache_creation_microcents, effective_from, valid_from, valid_to
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
      cache_creation_microcents: bigint | string | number | null;
      effective_from: string | Date;
      valid_from: string | Date | null;
      valid_to: string | Date | null;
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
        cacheCreationMicrocents: toN(r.cache_creation_microcents),
        effectiveFrom: toIso(r.effective_from),
        validFrom: r.valid_from === null ? null : toIso(r.valid_from),
        validTo: r.valid_to === null ? null : toIso(r.valid_to),
      })),
    });
  },
});

/**
 * One ai_pricing row as the Owner (or an approved AI proposal) writes it.
 * Exported so `owner_settings.propose_set_ai_pricing` validates the exact
 * shape the apply step will accept — a proposal that could never apply is
 * rejected before the operator is asked to click.
 *
 * Rates are microcents (1e-8 USD) PER 1K TOKENS. `cacheCreationMicrocents`
 * (cache WRITE rate, migration 0186) may stay NULL — the cost mapper then
 * bills cache writes at 1.25x the input rate. `validFrom` / `validTo` bound
 * the window the row is in force (NULL = open-ended); see pricing-cache.ts.
 */
export const aiPricingRowInput = z
  .object({
    provider: z.string().min(1).max(50),
    model: z.string().min(1).max(100),
    operationType: z.enum(["text", "image"]),
    inputMicrocents: z
      .number()
      .int()
      .nonnegative()
      .describe("Input rate in microcents PER 1K TOKENS: $3 per million tokens = 300000."),
    outputMicrocents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Output rate, microcents per 1K tokens; null for image rows priced per call."),
    cachedMicrocents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Cache-READ rate, microcents per 1K tokens; null if the provider has none."),
    cacheCreationMicrocents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Cache-WRITE rate, microcents per 1K tokens; null/omitted bills 1.25x input."),
    effectiveFrom: z
      .string()
      .datetime()
      .optional()
      .describe("ISO timestamp the row takes effect; omitted = now. Part of the row key."),
    validFrom: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .describe("Start of a dated price window (e.g. intro pricing); null = open."),
    validTo: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .describe("End of a dated price window; null = open-ended."),
  })
  .strict()
  .refine((r) => !r.validFrom || !r.validTo || r.validFrom <= r.validTo, {
    message: "validFrom must not be after validTo",
    path: ["validTo"],
  });

export const setAiPricingOp = defineOperation({
  name: "ai_pricing.set",
  // Why human-only: the direct write is the Owner's /security/ai/pricing
  // form. A rate decides what every AI call is billed at and whether the
  // budget gates trip, so the AI reaches it only through the §11.A gate
  // (`owner_settings.propose_set_ai_pricing` → the operator's Approve →
  // `owner_settings.execute_proposal`), never directly.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: aiPricingRowInput,
  output: z.object({ inserted: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const ts = input.effectiveFrom ?? new Date().toISOString();
    await tx.execute(sql`
      INSERT INTO ai_pricing
        (provider, model, operation_type, input_microcents, output_microcents, cached_microcents,
         cache_creation_microcents, effective_from, valid_from, valid_to)
      VALUES
        (${input.provider}, ${input.model}, ${input.operationType},
         ${input.inputMicrocents}, ${input.outputMicrocents}, ${input.cachedMicrocents},
         ${input.cacheCreationMicrocents ?? null},
         ${ts}::timestamptz,
         ${input.validFrom ?? null}::timestamptz,
         ${input.validTo ?? null}::timestamptz)
      ON CONFLICT (provider, model, operation_type, effective_from) DO UPDATE
        SET input_microcents = EXCLUDED.input_microcents,
            output_microcents = EXCLUDED.output_microcents,
            cached_microcents = EXCLUDED.cached_microcents,
            cache_creation_microcents = EXCLUDED.cache_creation_microcents,
            valid_from = EXCLUDED.valid_from,
            valid_to = EXCLUDED.valid_to
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
