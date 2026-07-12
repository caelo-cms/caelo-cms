// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // The chat IS the product (CLAUDE.md §1A / epic #186): anyone who can
  // edit lands in /edit, not on the admin dashboard — operators should
  // never NEED the admin area. Users without content.write (ops-only
  // roles) still get the dashboard. Checked BEFORE the setup probe: a
  // signed-in session proves setup is complete.
  if (locals.user) {
    throw redirect(303, locals.user.permissions.has("content.write") ? "/edit" : "/");
  }
  const { adapter, registry } = getQueryContext();
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  // CLAUDE.md §2 no-fallbacks: a failed probe must not silently count
  // as "no owner yet" — that shoved users onto /setup (live-hit
  // 2026-07-12, masked exactly this op's actor-scope rejection).
  if (!setup.ok) throw error(500, `users.is_setup_complete failed: ${setup.error.kind}`);
  if (!(setup.value as { complete: boolean }).complete) throw redirect(303, "/setup");
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
    // Straight into the live editor — same rationale as the load's
    // logged-in redirect. Permissions aren't resolved in this action
    // (only the raw token is); /edit's own guard bounces the rare
    // ops-only role, and the auth hook resolves the user on arrival.
    throw redirect(303, "/edit");
  },
};
