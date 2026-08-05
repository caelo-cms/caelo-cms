// SPDX-License-Identifier: MPL-2.0
import { runPluginOperation } from "@caelo-cms/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const r = await runPluginOperation({
        pluginSlug: "ratings",
        operationName: "list_aggregates",
        args: {},
    });
    const aggregates = r.ok ? (r.value.aggregates ?? []) : [];
    // Sort by count desc — most-rated pages first.
    aggregates.sort((a, b) => b.count - a.count);
    return { aggregates, error: r.ok ? null : r.error.message };
};
export const actions = {
    refresh: async ({ locals }) => {
        requirePermission(locals, "settings.write");
        const r = await runPluginOperation({
            pluginSlug: "ratings",
            operationName: "_refresh",
            args: {},
        });
        if (!r.ok)
            return fail(400, { error: r.error.message });
        const v = r.value;
        return { ok: true, message: `Recomputed ${v.refreshed} aggregate rows.` };
    },
};
