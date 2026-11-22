// SPDX-License-Identifier: MPL-2.0

/**
 * P16 hardening — in-process LRU for ai_pricing lookups.
 *
 * recordAiCall reads ai_pricing on every insert when the caller doesn't
 * supply costEstimateMicrocents. A 30-message chat = 30 lookups for the
 * same row. The cache is keyed by (provider, model, operationType) +
 * a 60s TTL, invalidated on `ai_pricing.set` via Postgres
 * LISTEN/NOTIFY (channel name `caelo_ai_pricing`). Per-process — tests
 * stay deterministic by clearing on cold start.
 */
import type { TransactionRunner } from "@caelo-cms/query-api";
import { type PricingCandidate, type PricingRow, pickPricingRow } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

interface CacheEntry {
  value: PricingRow | null;
  expiresAt: number;
}

const TTL_MS = 60_000;
const MAX_SIZE = 200;
const cache = new Map<string, CacheEntry>();

function key(provider: string, model: string, operationType: "text" | "image"): string {
  return `${provider}::${model}::${operationType}`;
}

/**
 * Reads the ai_pricing row in force for the (provider, model, operationType)
 * tuple at call time. Falls back to the provider-wildcard `*` row. Returns
 * NULL when no row exists at any specificity — caller treats that as "free"
 * or surfaces the gap.
 *
 * Validity-window selection (issue: Sonnet-5 intro pricing): rows may carry a
 * `[valid_from, valid_to]` window (either bound NULL = open-ended). Only rows
 * whose window contains `now()` are eligible; among those a dated window beats
 * the undated back-compat row, and the latest-starting window wins. The
 * undated row (both bounds NULL) applies when nothing is dated.
 *
 * The 60s cache is keyed only by (provider, model, op) — a window boundary
 * (e.g. the Sep-1 revert) is picked up within one TTL, acceptable for a
 * pricing transition and consistent with the pre-existing effective_from cut.
 */
export async function lookupPricing(
  tx: TransactionRunner,
  provider: string,
  model: string,
  operationType: "text" | "image",
): Promise<PricingRow | null> {
  const k = key(provider, model, operationType);
  const now = Date.now();
  const cached = cache.get(k);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  // Fetch every candidate row for the tuple (exact model + wildcard `*`) and
  // resolve which is in force in TS via `pickPricingRow` — the window +
  // precedence logic lives in one pure, unit-tested place rather than an
  // SQL ORDER BY. Row counts per tuple are small (a price history), so the
  // full fetch is cheap. `nowMs` is the app clock; DB/app skew is sub-second
  // and pricing windows are day-granular, so it cannot mis-window a call.
  const rows = (await tx.execute(sql`
    SELECT model, input_microcents, output_microcents, cached_microcents,
           cache_creation_microcents, long_prompt_threshold_tokens, long_prompt_multiplier,
           extract(epoch from effective_from) * 1000 AS effective_from_ms,
           extract(epoch from valid_from)      * 1000 AS valid_from_ms,
           extract(epoch from valid_to)        * 1000 AS valid_to_ms
    FROM ai_pricing
    WHERE provider = ${provider}
      AND model IN (${model}, '*')
      AND operation_type = ${operationType}
  `)) as unknown as Array<{
    model: string;
    input_microcents: bigint | string | number;
    output_microcents: bigint | string | number | null;
    cached_microcents: bigint | string | number | null;
    cache_creation_microcents: bigint | string | number | null;
    long_prompt_threshold_tokens: number | null;
    long_prompt_multiplier: number | null;
    effective_from_ms: bigint | string | number;
    valid_from_ms: bigint | string | number | null;
    valid_to_ms: bigint | string | number | null;
  }>;
  const candidates: PricingCandidate[] = rows.map((r) => ({
    model: r.model,
    inputMicrocents: toN(r.input_microcents) ?? 0,
    outputMicrocents: toN(r.output_microcents),
    cachedMicrocents: toN(r.cached_microcents),
    cacheCreationMicrocents: toN(r.cache_creation_microcents),
    longPromptThresholdTokens: r.long_prompt_threshold_tokens,
    longPromptMultiplier: r.long_prompt_multiplier,
    effectiveFromMs: toN(r.effective_from_ms) ?? 0,
    validFromMs: toN(r.valid_from_ms),
    validToMs: toN(r.valid_to_ms),
  }));
  const value: PricingRow | null = pickPricingRow(candidates, model, now);
  // Tiny hand-rolled LRU — Map preserves insertion order; oldest entry
  // is the first in iteration order. Drop one if at cap.
  if (cache.size >= MAX_SIZE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(k, { value, expiresAt: now + TTL_MS });
  return value;
}

function toN(v: bigint | string | number | null): number | null {
  if (v === null) return null;
  return typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number.parseInt(v, 10) : v;
}

/** Drop one entry. Called by the LISTEN handler on a single-row update. */
export function invalidatePricingEntry(
  provider: string,
  model: string,
  operationType: "text" | "image",
): void {
  cache.delete(key(provider, model, operationType));
}

/** Drop everything. Called when the LISTEN connection drops + reconnects. */
export function invalidateAllPricing(): void {
  cache.clear();
}
