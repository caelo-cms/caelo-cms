// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 — the exact payload one bug report would send to the Caelo
 * team, for the Owner's review on /settings/bugs. A plain JSON response
 * rather than load data, so the payload never sits in the page's
 * hydration state (same reasoning as /settings/ai/telemetry/preview).
 */

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, url }) => {
  requirePermission(locals, "settings.read");
  const reportId = url.searchParams.get("id") ?? "";
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "bug_forwarding.preview", { reportId });
  if (!r.ok) throw error(404, "no such bug report");
  return new Response(JSON.stringify((r.value as { payload: unknown }).payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
