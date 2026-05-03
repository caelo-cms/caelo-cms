// SPDX-License-Identifier: MPL-2.0

import { requirePermission } from "$lib/server/guards.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  return {};
};
