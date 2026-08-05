// SPDX-License-Identifier: MPL-2.0
import { error, redirect } from "@sveltejs/kit";
/**
 * Route guards. `+page.server.ts` / `+server.ts` files call these at the top
 * of their `load` / request handlers. Permission checks use the fixed
 * permission catalog (never role names) so custom roles integrate uniformly.
 */
export function requireUser(locals) {
    if (!locals.user)
        throw redirect(303, "/login");
    return locals.user;
}
export function requirePermission(locals, permission) {
    const user = requireUser(locals);
    if (!user.permissions.has(permission)) {
        throw error(403, `Missing required permission: ${permission}`);
    }
    return user;
}
export const SESSION_COOKIE = "caelo_session";
export const SESSION_COOKIE_OPTIONS = {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // `secure` only in production; dev serves over http.
    secure: process.env.NODE_ENV === "production",
};
