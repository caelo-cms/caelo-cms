// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  const complete = setup.ok ? (setup.value as { complete: boolean }).complete : false;
  if (complete) throw redirect(303, "/login");
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const displayName = String(form.get("displayName") ?? "").trim();

    if (!email || !password || !displayName) {
      return fail(400, { email, displayName, error: "All fields are required." });
    }
    if (password.length < 8) {
      return fail(400, { email, displayName, error: "Password must be at least 8 characters." });
    }

    const result = await execute(registry, adapter, locals.ctx, "users.create_first_owner", {
      email,
      password,
      displayName,
    });
    if (!result.ok) {
      return fail(400, { email, displayName, error: "Setup failed. Is there already an owner?" });
    }
    throw redirect(303, "/login");
  },
};
