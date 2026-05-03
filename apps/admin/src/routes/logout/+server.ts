// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { redirect } from "@sveltejs/kit";
import { SESSION_COOKIE } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ cookies, locals }) => {
  const { adapter, registry } = getQueryContext();
  const token = cookies.get(SESSION_COOKIE);
  if (token) {
    await execute(registry, adapter, locals.ctx, "auth.logout", { token });
    cookies.delete(SESSION_COOKIE, { path: "/" });
  }
  throw redirect(303, "/login");
};
