// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, redirect } from "@sveltejs/kit";
import { getQueryContext } from "#lib/server/query.js";
import { type DeployRunSummary, type SiteState, siteStateFrom } from "#lib/site-state.js";
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
  let pages: { status: string }[] = [];
  const pagesR = await execute(registry, adapter, locals.ctx, "pages.list", {});
  if (pagesR.ok) {
    pages = (pagesR.value as { pages: { status: string }[] }).pages;
    publishedPageCount = pages.filter((p) => p.status === "published").length;
  }

  // #779 — Draft / Preview / Live summary. Only rendered when both reads
  // succeeded: a half-known state would claim "nothing staged" or "not
  // live" without knowing it (CLAUDE.md §2 no-fallbacks).
  let siteState: SiteState | null = null;
  const runsR = await execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 200 });
  if (pagesR.ok && runsR.ok) {
    siteState = siteStateFrom(pages, (runsR.value as { runs: DeployRunSummary[] }).runs);
  }

  return {
    siteState,
    user: {
      email: locals.user.email,
      roles: locals.user.roles,
      permissions: [...locals.user.permissions].sort(),
    },
    publishedPageCount,
  };
};
