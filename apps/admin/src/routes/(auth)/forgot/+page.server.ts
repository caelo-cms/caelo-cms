// SPDX-License-Identifier: MPL-2.0

import { passwordResetEmailProblem } from "@caelo-cms/admin-core";
import { fail } from "@sveltejs/kit";
import { requestPasswordResetLink } from "#lib/server/forgot-password.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/**
 * #769 — whether this install can email a reset link at all. When it can't,
 * the page says so up front and names the operator's recovery command instead
 * of pretending a mail is on its way. That reveals the install's mail setup,
 * not whether any account exists.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const problem = await passwordResetEmailProblem({ registry, adapter, ctx: locals.ctx });
  return { emailUnavailable: problem !== null };
};

/**
 * Step 1 of self-service reset. Unauthenticated (`locals.ctx` is the system
 * actor here), so no CSRF token exists yet — same as /login. The response is
 * identical whether or not the address matches an account (no enumeration),
 * including when sending the email fails; see `requestPasswordResetLink`.
 */
export const actions: Actions = {
  default: async ({ request, locals, url, getClientAddress }) => {
    const { adapter, registry, loginLimiter } = getQueryContext();
    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim();

    // Rate-limit by IP so the endpoint can't be used to flood reset emails or
    // probe for accounts.
    const decision = await loginLimiter.consume(`reset:${getClientAddress()}`);
    if (!decision.allowed) {
      return fail(429, {
        email,
        error: `Too many requests. Try again in ${Math.ceil(decision.retryAfterMs / 1000)}s.`,
      });
    }

    if (!email) return fail(400, { email, error: "Enter your email address." });

    const outcome = await requestPasswordResetLink(
      { registry, adapter, ctx: locals.ctx, origin: url.origin },
      email,
    );
    if (outcome.kind === "email-unavailable") {
      return fail(409, { email, emailUnavailable: true });
    }

    // Always the same outcome — never reveal whether the account exists.
    return { sent: true };
  },
};
