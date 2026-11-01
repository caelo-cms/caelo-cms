// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6b — JSON endpoint backing the deployments page's live progress.
 * Returns the latest 25 runs, plus the Stage runs' step, progress and
 * estimated time left (#1288).
 */

import { execute } from "@caelo-cms/query-api";
import { json } from "@sveltejs/kit";
import { getQueryContext } from "#lib/server/query.js";
import { stageStatusOf } from "#lib/server/stage-status.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const [res, stage] = await Promise.all([
    execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 25 }),
    // #1288 — the Stage runs' step, progress and estimated time left.
    execute(registry, adapter, locals.ctx, "deploy.stage_status", { limit: 20 }),
  ]);
  if (!res.ok) return json({ runs: [] }, { status: 200 });
  return json({ ...(res.value as object), ...stageStatusOf(stage) });
};
