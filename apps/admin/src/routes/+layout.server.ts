// SPDX-License-Identifier: MPL-2.0

import { signCsrfToken } from "@caelo-cms/admin-core";
import type { LayoutServerLoad } from "./$types";

/**
 * Exposes a freshly-signed per-render CSRF token to every authenticated
 * page. The token is HMAC-SHA256(session.csrf_secret, timestamp.nonce) and
 * expires after 1h. Forms include it as a hidden `_csrf` input; the server
 * validates by recomputing on submit.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const csrfToken = locals.user ? await signCsrfToken(locals.user.csrfSecret) : "";
  return {
    csrfToken,
    currentUser: locals.user ? { email: locals.user.email, roles: [...locals.user.roles] } : null,
  };
};
