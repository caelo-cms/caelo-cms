// SPDX-License-Identifier: MPL-2.0

/**
 * GET /_caelo/csrf-token → `{ token }`: a new CSRF form token for the
 * signed-in session, for an open tab whose token is about to expire
 * (#lib/csrf-refresh.ts). 401 when signed out. Same token the root layout
 * load signs; a cross-site page cannot read it (no CORS headers), and it
 * is never cached.
 */

import { signCsrfToken } from "@caelo-cms/admin-core";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

const NO_STORE = { "cache-control": "no-store" };

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({ error: "Not signed in." }, { status: 401, headers: NO_STORE });
  return json({ token: await signCsrfToken(locals.user.csrfSecret) }, { headers: NO_STORE });
};
