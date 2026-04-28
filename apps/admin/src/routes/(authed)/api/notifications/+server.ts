// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6b — read-only JSON endpoint backing the AppShell's
 * NotificationBell. Wraps the `notifications.aggregate` op so the
 * client can poll without rendering a route.
 */

import { execute } from "@caelo/query-api";
import { json } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, locals.ctx, "notifications.aggregate", {});
  if (!res.ok) {
    return json(
      { pendingProposals: 0, failedDeploys: 0, staleBranches: 0, total: 0 },
      { status: 200 },
    );
  }
  return json(res.value);
};
