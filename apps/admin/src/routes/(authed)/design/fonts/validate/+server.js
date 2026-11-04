// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
export const POST = async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const body = await request.text();
    if (body.length > 210_000)
        throw error(413, "Specimen too large");
    let input;
    try {
        input = JSON.parse(body);
    }
    catch {
        throw error(400, "Invalid specimen request");
    }
    const { registry, adapter } = getQueryContext();
    const result = await execute(registry, adapter, locals.ctx, "fonts.resolve", input);
    return json(result.ok
        ? { ok: true }
        : {
            ok: false,
            error: result.error.kind === "HandlerError" ? result.error.message : "Invalid font specimen",
        }, { status: result.ok ? 200 : 422 });
};
