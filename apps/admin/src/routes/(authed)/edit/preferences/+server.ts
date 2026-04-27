// SPDX-License-Identifier: MPL-2.0

/**
 * Per-user preferences write endpoint used by the live-edit overlay's
 * layout-persistence loop. POST `{key, value}` — `value` is JSON-
 * serialisable; the op upserts `(user_id, key)`. CSRF via
 * `x-csrf-token` header (P5 convention; body is JSON, not form data).
 */

import { verifyCsrfToken } from "@caelo/admin-core";
import { execute } from "@caelo/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  requirePermission(locals, "content.write");
  if (!locals.user) throw error(401, "Not authenticated");
  const csrf = request.headers.get("x-csrf-token") ?? "";
  if (!(await verifyCsrfToken(locals.user.csrfSecret, csrf))) {
    throw error(403, "CSRF token mismatch");
  }

  const body = (await request.json()) as { key?: string; value?: unknown };
  if (!body.key || typeof body.key !== "string") {
    throw error(400, "key required");
  }
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "user_preferences.set", {
    key: body.key,
    value: body.value,
  });
  if (!result.ok) throw error(500, "could not save preference");
  return json({ ok: true });
};
