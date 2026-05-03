// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { getCapLookupHealth } from "@caelo/shared";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

type AggregateValue = {
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  };
  perDay: Array<{
    day: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  perProvider: Array<{
    provider: string;
    model: string;
    operationType: "text" | "image";
    calls: number;
    costUsd: number;
  }>;
  perOperationType: Array<{
    operationType: "text" | "image";
    calls: number;
    costUsd: number;
  }>;
  perPlugin: Array<{
    pluginId: string | null;
    pluginSlug: string | null;
    calls: number;
    costUsd: number;
  }>;
  perAttribution: Array<{
    kind: "plugin" | "user" | "subagent" | "system";
    label: string;
    calls: number;
    costUsd: number;
  }>;
};

type BudgetStatusRow = {
  scope: "session" | "day-global" | "day-per-actor";
  operationType: "text" | "image";
  capMicrocents: number | null;
  spentMicrocents: number | null;
  pct: number | null;
  status: "ok" | "warn" | "blocked" | "unknown";
};

const EMPTY: AggregateValue = {
  totals: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
  perDay: [],
  perProvider: [],
  perOperationType: [],
  perPlugin: [],
  perAttribution: [],
};

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const [aggR, statusR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "ai_calls.aggregate", {}),
    execute(registry, adapter, locals.ctx, "ai_budgets.status", {}),
  ]);
  const agg: AggregateValue = aggR.ok ? (aggR.value as AggregateValue) : EMPTY;
  const budgetStatus: BudgetStatusRow[] = statusR.ok
    ? ((statusR.value as { rows: BudgetStatusRow[] }).rows ?? [])
    : [];
  // P16 hardening — surface fail-closed trips so silent enforcement
  // bypass becomes operator-visible. Per-process state — one row per
  // worker. In a single-process self-hosted install this IS the trip
  // surface.
  const capLookupHealth = getCapLookupHealth();
  return { agg, budgetStatus, capLookupHealth };
};
