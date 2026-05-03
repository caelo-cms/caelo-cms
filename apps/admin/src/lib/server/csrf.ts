// SPDX-License-Identifier: MPL-2.0

import { verifyCsrfToken } from "@caelo-cms/admin-core";
import { error } from "@sveltejs/kit";

/**
 * Per-form CSRF check. Pairs with the per-render `signCsrfToken` call in
 * `+layout.server.ts`. The secret stays on the server; the form carries a
 * short-lived HMAC-derived token. Validation re-derives and compares.
 */
export async function assertCsrfToken(form: FormData, locals: App.Locals): Promise<void> {
  if (!locals.user) throw error(401, "Not authenticated");
  const provided = String(form.get("_csrf") ?? "");
  const ok = await verifyCsrfToken(locals.user.csrfSecret, provided);
  if (!ok) throw error(403, "CSRF token mismatch");
}
