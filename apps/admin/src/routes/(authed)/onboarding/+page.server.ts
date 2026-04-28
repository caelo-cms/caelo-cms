// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  // The (authed) layout already redirected unauthenticated users; this
  // load just surfaces an `alreadyOnboarded` flag the page uses to
  // render a "you've completed this — return to dashboard" affordance
  // when re-visited (e.g. via the user-menu "Show tour again" link).
  return { alreadyOnboarded: locals.user?.onboardedAt !== null };
};

export const actions: Actions = {
  complete: async ({ request, locals }) => {
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const result = await execute(registry, adapter, locals.ctx, "users.complete_onboarding", {});
    if (!result.ok) {
      return fail(500, { error: "Could not complete onboarding." });
    }
    redirect(303, "/");
  },
};
