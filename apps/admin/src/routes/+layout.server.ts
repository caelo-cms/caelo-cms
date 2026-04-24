// SPDX-License-Identifier: MPL-2.0

import type { LayoutServerLoad } from "./$types";

/**
 * Exposes the session's CSRF token to every authenticated page so forms can
 * include it as a hidden `_csrf` input. Also surfaces user identity fields
 * that almost every page wants to render.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    csrfToken: locals.user?.csrfToken ?? "",
    currentUser: locals.user ? { email: locals.user.email, roles: [...locals.user.roles] } : null,
  };
};
