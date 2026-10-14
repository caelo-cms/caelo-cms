// SPDX-License-Identifier: MPL-2.0

/**
 * The live timeline of an update (#696): the request and the events the
 * upgrader job wrote so far. Settings → Updates polls it while an update is
 * waiting or running. It reads the database only, so it works across the
 * admin restart an update causes.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  requirePermission(locals, "settings.read");
  const requestId = url.searchParams.get("requestId");
  const { adapter, registry } = getQueryContext();
  const r = await execute(
    registry,
    adapter,
    locals.ctx,
    "platform_updates.get",
    requestId ? { requestId } : {},
  );
  if (!r.ok) throw error(400, opErrorMessage(r.error, "could not read the update"));
  return json(r.value, { headers: { "Cache-Control": "no-store" } });
};
