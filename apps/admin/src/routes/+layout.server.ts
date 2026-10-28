// SPDX-License-Identifier: MPL-2.0

import { CSRF_TOKEN_TTL_MS, signCsrfToken } from "@caelo-cms/admin-core";
import type { LayoutServerLoad } from "./$types";

/**
 * Exposes a freshly-signed per-render CSRF token to every authenticated
 * page. The token is HMAC-SHA256(session.csrf_secret, timestamp.nonce) and
 * expires after 1h. Forms include it as a hidden `_csrf` input; the server
 * validates by recomputing on submit.
 *
 * SvelteKit reruns this load only on a full page load or after an enhanced
 * form submit, so an open tab renews the token itself: `csrfRefreshAfterMs`
 * (half the lifetime) tells +layout.svelte when to fetch a new one
 * (#lib/csrf-refresh.ts).
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const csrfToken = locals.user ? await signCsrfToken(locals.user.csrfSecret) : "";
  return {
    csrfToken,
    csrfRefreshAfterMs: CSRF_TOKEN_TTL_MS / 2,
    currentUser: locals.user ? { email: locals.user.email, roles: [...locals.user.roles] } : null,
  };
};
