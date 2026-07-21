// SPDX-License-Identifier: MPL-2.0

import { deliverPasswordResetEmail } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions } from "./$types";

/**
 * Step 1 of self-service reset. Unauthenticated (`locals.ctx` is the system
 * actor here), so no CSRF token exists yet — same as /login. The response is
 * identical whether or not the address matches an account (no enumeration); the
 * email is sent only when a matching account exists, out of the op's DB tx.
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

    const result = await execute(registry, adapter, locals.ctx, "auth.request_password_reset", {
      email,
    });
    if (result.ok) {
      const { delivery } = result.value as {
        delivery: { email: string; token: string; displayName: string } | null;
      };
      if (delivery) {
        const resetUrl = new URL(
          `/reset?token=${encodeURIComponent(delivery.token)}`,
          url.origin,
        ).toString();
        await deliverPasswordResetEmail({
          registry,
          adapter,
          ctx: locals.ctx,
          to: delivery.email,
          displayName: delivery.displayName,
          resetUrl,
        });
      }
    }

    // Always the same outcome — never reveal whether the account exists.
    return { sent: true };
  },
};
