// SPDX-License-Identifier: MPL-2.0

import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

/**
 * Permission-aware payload for the AppShell sidebar. Reads from the
 * already-resolved session in locals (populated by hooks.server.ts).
 * Unauthenticated users are bounced to /login.
 *
 * P6.6b — first-login onboarding: users with `onboardedAt === null`
 * are redirected to /onboarding once. The /onboarding route itself
 * is excluded from the redirect so the page renders normally; the
 * onboarding-complete action sets `onboarded_at = now()` and the next
 * request lands on the dashboard. `onboardedAt` ships through
 * `auth.resolve_session` so this check is a free property read.
 */
export const load: LayoutServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(303, "/login");
  if (locals.user.onboardedAt === null && url.pathname !== "/onboarding") {
    throw redirect(303, "/onboarding");
  }
  return {
    permissions: [...locals.user.permissions].sort(),
  };
};
