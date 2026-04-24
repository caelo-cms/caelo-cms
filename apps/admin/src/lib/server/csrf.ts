// SPDX-License-Identifier: MPL-2.0

import { error } from "@sveltejs/kit";

/**
 * Double-submit CSRF check. Pairs with SvelteKit's built-in Origin check:
 * every POST form from an authenticated context includes a hidden `_csrf`
 * input whose value must equal `locals.user.csrfToken`. Login / setup skip
 * this because the user has no session yet; Origin + rate-limit cover them.
 */
export function assertCsrfToken(form: FormData, locals: App.Locals): void {
  if (!locals.user) throw error(401, "Not authenticated");
  const provided = String(form.get("_csrf") ?? "");
  if (!provided || provided !== locals.user.csrfToken) {
    throw error(403, "CSRF token mismatch");
  }
}
