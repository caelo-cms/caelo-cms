// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { redirect } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { LayoutServerLoad } from "./$types";

/**
 * Permission-aware payload for the AppShell sidebar. Reads from the
 * already-resolved session in locals (populated by hooks.server.ts).
 * Unauthenticated users are bounced to /login.
 *
 * P6.6b — first-login onboarding: users with `onboardedAt === null`
 * are redirected to /onboarding once. The /onboarding route itself
 * is excluded from the redirect so the page renders normally; the
 * onboarding-complete action sets `onboarded_at = now()` and the next
 * request lands on the dashboard.
 *
 * P18 — first-run AI provider check: after onboarding completes, if
 * no AI provider is configured anywhere (DB-stored OR env-fallback),
 * redirect to /security/ai?firstRun=1 so the Owner sees a guided
 * "configure your first provider" banner instead of hitting "AI
 * provider not configured" the first time they open chat. Once any
 * provider is configured, this check is a one-query no-op per request
 * (and could be cached on locals later if it shows up in profiling).
 */

const AI_REDIRECT_ALLOWED_PREFIXES = [
  "/security/ai", // landing page itself + sub-routes
  "/security", // other Owner-only setup screens (deployments etc.)
  "/onboarding",
  "/logout",
  "/api/", // any internal endpoints
];

function pathExempt(pathname: string): boolean {
  return AI_REDIRECT_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const load: LayoutServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(303, "/login");
  if (locals.user.onboardedAt === null && url.pathname !== "/onboarding") {
    throw redirect(303, "/onboarding");
  }

  // P18 — block all non-/security routes until an AI provider exists.
  // Skip the check on routes the Owner needs to reach to fix the
  // problem (anything under /security or /onboarding) so we don't loop.
  if (!pathExempt(url.pathname)) {
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "ai_providers.any_configured", {});
    if (r.ok && !(r.value as { anyConfigured: boolean }).anyConfigured) {
      throw redirect(303, "/security/ai?firstRun=1");
    }
  }

  return {
    permissions: [...locals.user.permissions].sort(),
  };
};
