// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — what the next Publish live does to the redirects, for its
 * confirmation in the editor toolbar:
 *
 *   GET → redirects.release_plan: { goingLive, waiting, draft, problem }
 *
 * The confirmation posts the `goingLive` changes (id + revision) back with
 * Publish live, so exactly what it listed goes live; a change saved after
 * it waits for the next Publish live.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  requirePermission(locals, "deploy.trigger");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "redirects.release_plan", {});
  if (!r.ok) throw error(500, "message" in r.error ? String(r.error.message) : r.error.kind);
  return json(r.value);
};
