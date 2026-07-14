// SPDX-License-Identifier: MPL-2.0

/**
 * Resolve the active model's cost-per-MTok from the operator-editable
 * `ai_pricing` table — the SAME source `chat.record_ai_call` bills the DB
 * row from. The streamed `usage.cost` used to fall back to the Opus-tier
 * DEFAULT_* constants for every model, so a live claude-sonnet-5 turn
 * reported ~5× its real cost (run-logs/token-efficiency-analysis.md). Pure
 * except for the ai_pricing read; returns null when no row matches so the
 * caller can fall back loudly.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { AIProvider } from "../provider.js";

/** ai_pricing stores microcents per 1K tokens; USD per MTok = µ¢/1K ÷ 100_000
 *  (× 1000 tokens/1K ÷ 1e8 µ¢/USD). Division keeps round rates exact. */
const MICROCENTS_PER_1K_TO_USD_PER_MTOK_DIVISOR = 100_000;

export interface ModelCostPerMTok {
  readonly inputCostPerMTok: number;
  readonly outputCostPerMTok: number;
}

export interface AiPricingRow {
  readonly provider: string;
  readonly model: string;
  readonly operationType: "text" | "image";
  readonly inputMicrocents: number;
  readonly outputMicrocents: number | null;
}

/**
 * Pure: pick the text-rate row for (provider, model) — exact model wins over
 * the provider `*` wildcard — and convert to USD/MTok. Null when no usable
 * row (missing, or no output rate). Exported for unit tests.
 */
export function pickModelRates(
  rows: readonly AiPricingRow[],
  providerName: string,
  model: string,
): ModelCostPerMTok | null {
  const row =
    rows.find(
      (r) => r.provider === providerName && r.model === model && r.operationType === "text",
    ) ?? rows.find((r) => r.provider === providerName && r.model === "*" && r.operationType === "text");
  if (!row || row.outputMicrocents === null) return null;
  return {
    inputCostPerMTok: row.inputMicrocents / MICROCENTS_PER_1K_TO_USD_PER_MTOK_DIVISOR,
    outputCostPerMTok: row.outputMicrocents / MICROCENTS_PER_1K_TO_USD_PER_MTOK_DIVISOR,
  };
}

export async function resolveModelCostPerMTok(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  provider: AIProvider,
): Promise<ModelCostPerMTok | null> {
  const res = await execute(registry, adapter, ctx, "ai_pricing.list", {});
  if (!res.ok) return null;
  const rows = (res.value as { rows: AiPricingRow[] }).rows;
  return pickModelRates(rows, provider.name, provider.model);
}
