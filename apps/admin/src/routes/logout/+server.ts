// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { SESSION_COOKIE } from "#lib/server/guards.js";
import { clearPreviewAssetGrant } from "#lib/server/preview-asset-grant.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

/**
 * Sign out. A live session is ended only with the form's CSRF token (PR
 * #863, L-07): without it any site could log an operator out mid-edit. A
 * cookie whose session is already gone is just cleared — there is nothing
 * left to protect.
 */
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
  const { adapter, registry } = getQueryContext();
  const token = cookies.get(SESSION_COOKIE);
  if (token && locals.user) {
    await assertCsrfToken(await request.formData(), locals);
    await execute(registry, adapter, locals.ctx, "auth.logout", { token });
  }
  if (token) cookies.delete(SESSION_COOKIE, { path: "/" });
  // #946 — the preview's read-only media grant ends with the session.
  clearPreviewAssetGrant(cookies);
  throw redirect(303, "/login");
};
