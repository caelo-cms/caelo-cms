// SPDX-License-Identifier: MPL-2.0

import { error } from "@sveltejs/kit";
import { requireUser } from "#lib/server/guards.js";
import { hasAnySettingsAccess } from "#lib/settings-nav.js";
import type { PageServerLoad } from "./$types";

/**
 * The Settings overview lists only the pages the viewer's role may open
 * (filtered from the same permissions the AppShell gets), so the gate here
 * is "can open at least one of them" — an editor with only `content.read`
 * still finds Redirects.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  if (!hasAnySettingsAccess(user.permissions)) {
    throw error(403, "Your role cannot open any Settings page. Ask the site Owner for access.");
  }
  return {};
};
