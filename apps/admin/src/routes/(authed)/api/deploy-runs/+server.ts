// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6b — JSON endpoint backing the deployments page's progress
 * polling. Returns the latest 25 runs; the client filters for
 * `running` status to decide whether to keep polling.
 */

import { execute } from "@caelo-cms/query-api";
import { json } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 25 });
  if (!res.ok) return json({ runs: [] }, { status: 200 });
  return json(res.value);
};
