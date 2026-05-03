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
  cachedMicrocents: number | null;
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
 * Reads the latest-effective ai_pricing row for the (provider, model,
 * operationType) tuple. Falls back to the provider-wildcard `*` row.
 * Returns NULL when no row exists at any specificity — caller treats
 * that as "free" or surfaces the gap.
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
  const rows = (await tx.execute(sql`
    SELECT input_microcents, output_microcents, cached_microcents
    FROM ai_pricing
    WHERE provider = ${provider}
      AND model IN (${model}, '*')
      AND operation_type = ${operationType}
      AND effective_from <= now()
    ORDER BY (model = ${model}) DESC, effective_from DESC
    LIMIT 1
  `)) as unknown as Array<{
    input_microcents: bigint | string | number;
    output_microcents: bigint | string | number | null;
    cached_microcents: bigint | string | number | null;
  }>;
  const r = rows[0];
  const value: PricingRow | null = r
    ? {
        inputMicrocents: toN(r.input_microcents) ?? 0,
        outputMicrocents: toN(r.output_microcents),
        cachedMicrocents: toN(r.cached_microcents),
      }
    : null;
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
  return typeof v === "bigint"
    ? Number(v)
    : typeof v === "string"
      ? Number.parseInt(v, 10)
      : v;
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
