// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { redirect } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  // Route to /setup when there are no users yet; otherwise require login.
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  const complete = setup.ok ? (setup.value as { complete: boolean }).complete : true;
  if (!complete) throw redirect(303, "/setup");
  if (!locals.user) throw redirect(303, "/login");

  return {
    user: {
      email: locals.user.email,
      roles: locals.user.roles,
      permissions: [...locals.user.permissions].sort(),
    },
  };
};
