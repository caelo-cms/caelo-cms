// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const { adapter, registry } = getQueryContext();
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  // CLAUDE.md §2 no-fallbacks: a failed probe must not silently count
  // as "setup incomplete" — that rendered the setup form to signed-in
  // users (live-hit 2026-07-12, this op was system-only-scoped then).
  if (!setup.ok) throw error(500, `users.is_setup_complete failed: ${setup.error.kind}`);
  if ((setup.value as { complete: boolean }).complete) throw redirect(303, "/login");

  // P14 — bootstrap-token gate.
  // If any token has ever been issued (cms-provision was run), /setup
  // hard-requires ?token=<…>. If none was ever issued (raw `bun run dev`
  // checkout), fall back to the unauthenticated path so contributors can
  // still spin up locally without minting a token first.
  const issued = await execute(
    registry,
    adapter,
    locals.ctx,
    "owner_bootstrap_tokens.any_issued",
    {},
  );
  // CLAUDE.md §2 no-fallbacks: a failed probe must not render the form as
  // if no token were required (users.create_first_owner enforces the gate
  // either way; this only decides what the form asks for).
  if (!issued.ok) {
    throw error(500, `owner_bootstrap_tokens.any_issued failed: ${issued.error.kind}`);
  }
  const tokenRequired = (issued.value as { anyIssued: boolean }).anyIssued;

  const tokenFromQuery = url.searchParams.get("token") ?? "";
  return { tokenRequired, tokenFromQuery };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const { adapter, registry } = getQueryContext();

    // Mirror the load guard for POSTs. Without this, a browser whose
    // last navigation was the setup POST re-submits on reload, the op
    // fails ("owner exists") and fail(400) re-renders the form — the
    // operator is stuck on a page that GET would have redirected away
    // from. Live-hit on 2026-07-12.
    const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
    if (!setup.ok) throw error(500, `users.is_setup_complete failed: ${setup.error.kind}`);
    if ((setup.value as { complete: boolean }).complete) {
      throw redirect(303, "/login");
    }

    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const displayName = String(form.get("displayName") ?? "").trim();
    const token = String(form.get("token") ?? "").trim();

    if (!email || !password || !displayName) {
      return fail(400, { email, displayName, error: "All fields are required." });
    }
    // Password policy, the bootstrap-token gate and its single-use
    // redemption all run inside users.create_first_owner's transaction, so
    // a rejected attempt never burns the token (PR #863, L-06).
    const result = await execute(registry, adapter, locals.ctx, "users.create_first_owner", {
      email,
      password,
      displayName,
      ...(token ? { bootstrapToken: token } : {}),
    });
    if (!result.ok) {
      // Surfaces the password-strength / token reason, "setup already
      // complete", or which field the schema rejected.
      const message =
        result.error.kind === "ValidationFailed"
          ? `Check the form: ${result.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}.`
          : opErrorMessage(
              result.error,
              "Setup failed — an owner account may already exist. Sign in at /login instead.",
            );
      return fail(400, { email, displayName, error: message });
    }
    throw redirect(303, "/login");
  },
};
