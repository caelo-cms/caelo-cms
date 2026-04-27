// SPDX-License-Identifier: MPL-2.0

import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

/**
 * Permission-aware payload for the AppShell sidebar. Reads from the
 * already-resolved session in locals (populated by hooks.server.ts).
 * Unauthenticated users are bounced to /login.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, "/login");
  return {
    permissions: [...locals.user.permissions].sort(),
  };
};
