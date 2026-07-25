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
import { sql } from "drizzle-orm";

export interface PricingRow {
  inputMicrocents: number;
  outputMicrocents: number | null;
  /** Cache-READ (`cache_read_input_tokens`) rate per 1K tokens. */
  cachedMicrocents: number | null;
  /** Cache-WRITE (`cache_creation_input_tokens`) rate per 1K tokens; NULL
   *  lets the cost mapper default to 1.25x the input rate. */
  cacheCreationMicrocents: number | null;
}

/**
 * A candidate ai_pricing row for one (provider, operationType), carrying the
 * fields `pickPricingRow` needs to choose the row in force at a given time:
 * the rates plus the model (for exact-vs-wildcard specificity) and the
 * validity/effective timestamps as epoch ms (null bound = open-ended).
 */
export interface PricingCandidate extends PricingRow {
  model: string;
  effectiveFromMs: number;
  validFromMs: number | null;
  validToMs: number | null;
}

/**
 * Pick the ai_pricing row in force at `nowMs` from candidates already scoped
 * to one (provider, operationType). Eligibility: `effective_from` has passed
 * AND the `[valid_from, valid_to]` window (either bound open) contains
 * `nowMs`. Precedence among the eligible: exact-model beats the wildcard `*`,
 * then a DATED window beats the undated back-compat row, then the
 * latest-starting window wins, then the latest `effective_from`. Returns the
 * `PricingRow` rate subset, or null when nothing is eligible.
 *
 * Pure + exported so validity-window selection is unit-testable without a DB.
 */
export function pickPricingRow(
  candidates: readonly PricingCandidate[],
  requestedModel: string,
  nowMs: number,
): PricingRow | null {
  const eligible = candidates.filter(
    (c) =>
      c.effectiveFromMs <= nowMs &&
      (c.validFromMs === null || c.validFromMs <= nowMs) &&
      (c.validToMs === null || c.validToMs >= nowMs),
  );
  if (eligible.length === 0) return null;
  const exact = (c: PricingCandidate) => (c.model === requestedModel ? 1 : 0);
  const dated = (c: PricingCandidate) => (c.validFromMs !== null || c.validToMs !== null ? 1 : 0);
  // Later in each ranked dimension wins; `beats(b, a)` = "b outranks a".
  const beats = (b: PricingCandidate, a: PricingCandidate): boolean => {
    if (exact(b) !== exact(a)) return exact(b) > exact(a);
    if (dated(b) !== dated(a)) return dated(b) > dated(a);
    const bf = b.validFromMs ?? Number.NEGATIVE_INFINITY;
    const af = a.validFromMs ?? Number.NEGATIVE_INFINITY;
    if (bf !== af) return bf > af;
    return b.effectiveFromMs > a.effectiveFromMs;
  };
  const best = eligible.reduce((a, b) => (beats(b, a) ? b : a));
  return {
    inputMicrocents: best.inputMicrocents,
    outputMicrocents: best.outputMicrocents,
    cachedMicrocents: best.cachedMicrocents,
    cacheCreationMicrocents: best.cacheCreationMicrocents,
  };
}

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
           cache_creation_microcents,
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
