// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { getCapLookupHealth } from "@caelo-cms/shared";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
const EMPTY = {
    totals: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
    perDay: [],
    perProvider: [],
    perOperationType: [],
    perPlugin: [],
    perAttribution: [],
};
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.read");
    const { adapter, registry } = getQueryContext();
    const [aggR, statusR] = await Promise.all([
        execute(registry, adapter, locals.ctx, "ai_calls.aggregate", {}),
        execute(registry, adapter, locals.ctx, "ai_budgets.status", {}),
    ]);
    const agg = aggR.ok ? aggR.value : EMPTY;
    const budgetStatus = statusR.ok
        ? (statusR.value.rows ?? [])
        : [];
    // P16 hardening — surface fail-closed trips so silent enforcement
    // bypass becomes operator-visible. Per-process state — one row per
    // worker. In a single-process self-hosted install this IS the trip
    // surface.
    const capLookupHealth = getCapLookupHealth();
    return { agg, budgetStatus, capLookupHealth };
};
