// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  const complete = setup.ok ? (setup.value as { complete: boolean }).complete : false;
  if (!complete) throw redirect(303, "/setup");
  if (locals.user) throw redirect(303, "/");
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies, locals, getClientAddress }) => {
    const { adapter, registry, loginLimiter } = getQueryContext();
    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    // Postgres-backed sliding-window limiter — shared across admin replicas.
    const ip = getClientAddress();
    const decision = await loginLimiter.consume(`login:${ip}`);
    if (!decision.allowed) {
      return fail(429, {
        email,
        error: `Too many login attempts. Try again in ${Math.ceil(decision.retryAfterMs / 1000)}s.`,
      });
    }

    const result = await execute(registry, adapter, locals.ctx, "auth.login", { email, password });
    if (!result.ok) {
      return fail(401, { email, error: "Invalid email or password." });
    }
    const v = result.value as { token: string; expiresAt: string };
    cookies.set(SESSION_COOKIE, v.token, {
      ...SESSION_COOKIE_OPTIONS,
      expires: new Date(v.expiresAt),
    });
    throw redirect(303, "/");
  },
};
