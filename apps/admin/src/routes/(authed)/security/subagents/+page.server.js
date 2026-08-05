// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "subagent_runs.list", { limit: 100 });
    const runs = r.ok ? r.value.runs : [];
    return { runs };
};
