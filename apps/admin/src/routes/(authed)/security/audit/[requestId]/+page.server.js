// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals, params }) => {
    requirePermission(locals, "settings.read");
    const requestId = params.requestId;
    if (!requestId || requestId.length > 64)
        throw error(400, "invalid requestId");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "audit.by_request_id", { requestId });
    if (!r.ok)
        throw error(500, "lookup failed");
    const v = r.value;
    return { requestId, ...v };
};
