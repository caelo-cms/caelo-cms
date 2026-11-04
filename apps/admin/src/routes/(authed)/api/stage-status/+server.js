// SPDX-License-Identifier: MPL-2.0
/**
 * #1288 — where the Stage runs stand, with an estimate of the time left
 * (`deploy.stage_status`). Read by the Live Edit Staging menu while it is
 * open, on its `deploys` live topic — never on a timer (CLAUDE.md §11.B).
 * A failed read answers with its error; the menu shows it.
 */
import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { json } from "@sveltejs/kit";
import { getQueryContext } from "#lib/server/query.js";
export const GET = async ({ locals, url }) => {
    const { adapter, registry } = getQueryContext();
    const limit = Number(url.searchParams.get("limit") ?? "1");
    const res = await execute(registry, adapter, locals.ctx, "deploy.stage_status", {
        limit: Number.isInteger(limit) ? limit : 1,
    });
    if (!res.ok)
        return json({ error: describeError(res.error) }, { status: 500 });
    return json(res.value);
};
