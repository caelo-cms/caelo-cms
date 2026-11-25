// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { getCapLookupHealth } from "@caelo-cms/shared";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
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
    provider: string;
    model: string;
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
  // #1654 — what visitors' AI conversations spent, from the gateway's ledger
  // in cms_public (validated row by row; the public side writes it).
  const visitorR = await execute(registry, adapter, locals.ctx, "visitor_ai.spend", {});
  const visitorAi = visitorR.ok
    ? (visitorR.value as { last24hUsd: number; last30dUsd: number; dropped: number })
    : null;
  return { agg, budgetStatus, capLookupHealth, visitorAi };
};
