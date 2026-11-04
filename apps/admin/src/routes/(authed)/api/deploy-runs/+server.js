// SPDX-License-Identifier: MPL-2.0
/**
 * P6.6b — JSON endpoint backing the deployments page's live progress.
 * Returns the latest 25 runs, plus the Stage runs' step, progress and
 * estimated time left (#1288).
 */
import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { json } from "@sveltejs/kit";
import { getQueryContext } from "#lib/server/query.js";
import { stageStatusOf } from "#lib/server/stage-status.js";
export const GET = async ({ locals }) => {
    const { adapter, registry } = getQueryContext();
    const [res, stage] = await Promise.all([
        execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 25 }),
        // #1288 — the Stage runs' step, progress and estimated time left.
        execute(registry, adapter, locals.ctx, "deploy.stage_status", { limit: 20 }),
    ]);
    // A failed read is an error, not an empty list: the page keeps what it
    // shows (it re-reads only on `r.ok`) instead of rendering a partial body.
    if (!res.ok)
        return json({ error: describeError(res.error) }, { status: 500 });
    return json({ ...res.value, ...stageStatusOf(stage) });
};
