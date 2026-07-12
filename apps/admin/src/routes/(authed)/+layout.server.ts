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
 * v0.11.4 (issue #76 follow-up) — the legacy /onboarding tour was
 * removed. Caelo is a chat-first product per CLAUDE.md §1A: the
 * operator opens /edit and describes outcomes, and the AI captures
 * site identity + builds the page from those outcomes. There's no
 * forms-based onboarding step. The `users.onboarded_at` column
 * remains but is no longer gate-checked anywhere — kept for
 * historical compatibility and to avoid a destructive migration on
 * dogfood installs.
 *
 * P18 — first-run AI provider check: if no AI provider is configured
 * anywhere (DB-stored OR env-fallback), redirect to the /welcome/ai
 * wizard (pick provider → paste key → land in chat) instead of
 * hitting "AI provider not configured" the first time they open
 * chat. The full management surface stays at /security/ai; the
 * wizard links to it. Once any provider is configured, this check
 * is a one-query no-op per request.
 */

const AI_REDIRECT_ALLOWED_PREFIXES = [
  "/security/ai", // landing page itself + sub-routes
  "/security", // other Owner-only setup screens (deployments etc.)
  "/logout",
  "/api/", // any internal endpoints
];

function pathExempt(pathname: string): boolean {
  return AI_REDIRECT_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const load: LayoutServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(303, "/login");

  // P18 — block all non-/security routes until an AI provider exists.
  // Skip the check on routes the Owner needs to reach to fix the
  // problem (anything under /security) so we don't loop.
  if (!pathExempt(url.pathname)) {
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "ai_providers.any_configured", {});
    if (r.ok && !(r.value as { anyConfigured: boolean }).anyConfigured) {
      throw redirect(303, "/welcome/ai");
    }
  }

  return {
    permissions: [...locals.user.permissions].sort(),
  };
};
