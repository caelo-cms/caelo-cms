// SPDX-License-Identifier: MPL-2.0

/**
 * Google's redirect after a step-up sign-in (#696). Exchanges the code
 * server-side, checks the ID token proves a fresh sign-in by this Caelo
 * user's Google account, records it on the session (admin-core
 * security/step-up/complete.ts), and returns to Settings → Updates with the
 * outcome in a short-lived flash cookie — never in the URL.
 */

import { completeGoogleStepUp } from "@caelo-cms/admin-core";
import { redirect } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import { googleTokenFetch, STEP_UP_RESULT_COOKIE, sessionHashFrom } from "#lib/server/step-up.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  requirePermission(locals, "platform.update");
  const sessionHash = await sessionHashFrom(cookies);
  if (!sessionHash) throw redirect(303, "/login");
  const { adapter, registry } = getQueryContext();
  const outcome = await completeGoogleStepUp({
    registry,
    adapter,
    ctx: locals.ctx,
    sessionHash,
    state: url.searchParams.get("state"),
    code: url.searchParams.get("code"),
    error: url.searchParams.get("error"),
    fetch: googleTokenFetch(),
  });
  cookies.set(
    STEP_UP_RESULT_COOKIE,
    JSON.stringify(
      outcome.ok
        ? { ok: true, purpose: outcome.purpose, message: "Confirmed with Google." }
        : { ok: false, purpose: "", message: outcome.message },
    ),
    {
      path: "/settings/updates",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60,
    },
  );
  throw redirect(303, outcome.returnTo);
};
