// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const [budgetsR, statusR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "ai_budgets.list", {}),
    execute(registry, adapter, locals.ctx, "ai_budgets.status", {}),
  ]);
  type Budget = {
    scope: "session" | "day-global" | "day-per-actor";
    operationType: "text" | "image";
    capMicrocents: number | null;
    warnAtPct: number;
    updatedAt: string;
  };
  type Status = Budget & {
    spentMicrocents: number | null;
    pct: number | null;
    status: "ok" | "warn" | "blocked" | "unknown";
  };
  const budgets = budgetsR.ok ? ((budgetsR.value as { rows: Budget[] }).rows ?? []) : [];
  const statuses = statusR.ok ? ((statusR.value as { rows: Status[] }).rows ?? []) : [];

  // Index status by (scope, op_type) for the form view.
  const statusKey = (s: { scope: string; operationType: string }) =>
    `${s.scope}/${s.operationType}`;
  const statusMap = new Map(statuses.map((s) => [statusKey(s), s]));

  // Render all 6 cells (3 scopes × 2 op types) — even unconfigured ones
  // so the Owner can set new caps without first inserting a placeholder row.
  const SCOPES = ["session", "day-global", "day-per-actor"] as const;
  const OP_TYPES = ["text", "image"] as const;
  const matrix = SCOPES.flatMap((scope) =>
    OP_TYPES.map((op) => {
      const cur = budgets.find((b) => b.scope === scope && b.operationType === op);
      const status = statusMap.get(`${scope}/${op}`);
      return {
        scope,
        operationType: op,
        capMicrocents: cur?.capMicrocents ?? null,
        warnAtPct: cur?.warnAtPct ?? 0.8,
        spentMicrocents: status?.spentMicrocents ?? null,
        pct: status?.pct ?? null,
        status: status?.status ?? "unknown",
      };
    }),
  );
  return { matrix };
};

export const actions: Actions = {
  set: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const scope = String(form.get("scope") ?? "") as
      | "session"
      | "day-global"
      | "day-per-actor";
    const operationType = String(form.get("operationType") ?? "text") as "text" | "image";
    const capRaw = String(form.get("capMicrocents") ?? "");
    const warnRaw = String(form.get("warnAtPct") ?? "0.8");
    const capMicrocents = capRaw === "" ? null : Number.parseInt(capRaw, 10);
    const warnAtPct = Number.parseFloat(warnRaw);
    if (Number.isNaN(warnAtPct) || warnAtPct < 0 || warnAtPct > 1) {
      return fail(400, { error: "warnAtPct must be 0.0..1.0" });
    }

    const r = await execute(registry, adapter, locals.ctx, "ai_budgets.set", {
      scope,
      operationType,
      capMicrocents,
      warnAtPct,
    });
    if (!r.ok) return fail(400, { error: "could not save budget row" });
    return { ok: true, key: `${scope}/${operationType}` };
  },
};
