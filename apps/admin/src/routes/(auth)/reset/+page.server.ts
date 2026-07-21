// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { opErrorMessage } from "$lib/server/op-error.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** The token rides in the query string of the emailed link. */
export const load: PageServerLoad = ({ url }) => {
  return { token: url.searchParams.get("token") ?? "" };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirm = String(form.get("confirm") ?? "");

    if (!token) {
      return fail(400, { error: "This reset link is missing its token. Request a new one." });
    }
    if (newPassword !== confirm) {
      return fail(400, { token, error: "The two passwords don't match." });
    }

    const result = await execute(registry, adapter, locals.ctx, "auth.reset_password", {
      token,
      newPassword,
    });
    if (!result.ok) {
      // Surfaces the strength reason or the invalid/expired-token message.
      return fail(400, {
        token,
        error: opErrorMessage(result.error, "Could not reset your password."),
      });
    }

    // Reset revokes all sessions — send them to sign in with the new password.
    throw redirect(303, "/login?reset=1");
  },
};
