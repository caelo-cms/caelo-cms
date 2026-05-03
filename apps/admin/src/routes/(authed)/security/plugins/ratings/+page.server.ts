// SPDX-License-Identifier: MPL-2.0

import { runPluginOperation } from "@caelo/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { Actions, PageServerLoad } from "./$types";

interface AggregateRow {
  page_id: string;
  locale: string;
  count: number;
  sum: number;
  average: number;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const r = await runPluginOperation({
    pluginSlug: "ratings",
    operationName: "list_aggregates",
    args: {},
  });
  const aggregates = r.ok ? ((r.value as { aggregates: AggregateRow[] }).aggregates ?? []) : [];
  // Sort by count desc — most-rated pages first.
  aggregates.sort((a, b) => b.count - a.count);
  return { aggregates, error: r.ok ? null : r.error.message };
};

export const actions: Actions = {
  refresh: async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const r = await runPluginOperation({
      pluginSlug: "ratings",
      operationName: "_refresh",
      args: {},
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    const v = r.value as { refreshed: number };
    return { ok: true, message: `Recomputed ${v.refreshed} aggregate rows.` };
  },
};
