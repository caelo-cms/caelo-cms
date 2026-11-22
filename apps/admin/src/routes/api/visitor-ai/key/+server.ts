// SPDX-License-Identifier: MPL-2.0

/**
 * #1654 — the Owner's visitor-AI key: `POST` stores (or rotates) it, `DELETE`
 * removes it. Called by the approval card of `propose_set_visitor_ai` before
 * its Approve, and by Settings → Visitor AI.
 *
 * The key goes from the request to the secret store (write-only for the
 * admin) and nowhere else: never into the chat, a database or a log. Needs
 * `settings.write`, the permission the proposal's approver needs too.
 */

import { removeVisitorAiKey, storeVisitorAiKey } from "@caelo-cms/admin-core";
import { error, json } from "@sveltejs/kit";
import { assertJsonCsrf } from "#lib/server/agent-runs.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw error(400, "Send JSON");
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  requirePermission(locals, "settings.write");
  await assertJsonCsrf(request, locals);
  const { adapter, registry } = getQueryContext();
  const r = await storeVisitorAiKey(registry, adapter, locals.ctx, await body(request));
  return json(r, { status: r.ok ? 200 : 422, headers: { "cache-control": "no-store" } });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  requirePermission(locals, "settings.write");
  await assertJsonCsrf(request, locals);
  const raw = (await body(request)) as { environment?: unknown };
  const which = raw.environment;
  if (which !== "live" && which !== "staging" && which !== "both")
    throw error(400, 'environment must be "live", "staging" or "both"');
  const { adapter, registry } = getQueryContext();
  const r = await removeVisitorAiKey(registry, adapter, locals.ctx, which);
  return json(r, { status: r.ok ? 200 : 422, headers: { "cache-control": "no-store" } });
};
