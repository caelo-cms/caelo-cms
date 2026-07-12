// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, redirect } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  // Route to /setup when there are no users yet; otherwise require login.
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  // CLAUDE.md §2 no-fallbacks: fail loudly instead of guessing.
  if (!setup.ok) throw error(500, `users.is_setup_complete failed: ${setup.error.kind}`);
  if (!(setup.value as { complete: boolean }).complete) throw redirect(303, "/setup");
  if (!locals.user) throw redirect(303, "/login");

  // P19 — surface "Ramp up your site" hero card while the install has
  // zero published pages. pages.list returns the full set; we just
  // filter client-side. Tiny lists at ramp-up time so this is cheap;
  // dedicated filter param is a P19 polish concern.
  let publishedPageCount = 0;
  const pagesR = await execute(registry, adapter, locals.ctx, "pages.list", {});
  if (pagesR.ok) {
    const v = pagesR.value as { pages: { status: string }[] };
    publishedPageCount = v.pages.filter((p) => p.status === "published").length;
  }

  return {
    user: {
      email: locals.user.email,
      roles: locals.user.roles,
      permissions: [...locals.user.permissions].sort(),
    },
    publishedPageCount,
  };
};
