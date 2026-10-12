// SPDX-License-Identifier: MPL-2.0

/**
 * #650 — "Open staging". Admin access ⇒ staging access: an operator who can
 * read content gets a two-minute signed link that the gateway on
 * staging.<domain> turns into a staging session cookie, then lands on
 * `?path=` there. Every staging link in the admin points here, never at
 * the provider's preview origin.
 */

import { execute } from "@caelo-cms/query-api";
import { error, redirect } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, url }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "staging_access.issue_open_link", {
    path: url.searchParams.get("path") ?? "/",
  });
  if (!r.ok) {
    const message =
      "message" in r.error ? String((r.error as { message: unknown }).message) : r.error.kind;
    throw error(409, message);
  }
  throw redirect(303, (r.value as { url: string }).url);
};
