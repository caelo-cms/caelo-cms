// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const { adapter, registry } = getQueryContext();
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  const complete = setup.ok ? (setup.value as { complete: boolean }).complete : false;
  if (complete) throw redirect(303, "/login");

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
  const tokenRequired = issued.ok ? (issued.value as { anyIssued: boolean }).anyIssued : false;

  const tokenFromQuery = url.searchParams.get("token") ?? "";
  return { tokenRequired, tokenFromQuery };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const displayName = String(form.get("displayName") ?? "").trim();
    const token = String(form.get("token") ?? "").trim();

    if (!email || !password || !displayName) {
      return fail(400, { email, displayName, error: "All fields are required." });
    }
    if (password.length < 8) {
      return fail(400, { email, displayName, error: "Password must be at least 8 characters." });
    }

    // Re-check the gate inside the action — load happens at GET time.
    const issued = await execute(
      registry,
      adapter,
      locals.ctx,
      "owner_bootstrap_tokens.any_issued",
      {},
    );
    const tokenRequired = issued.ok ? (issued.value as { anyIssued: boolean }).anyIssued : false;

    if (tokenRequired) {
      if (!token) {
        return fail(400, {
          email,
          displayName,
          error: "Bootstrap token required. Open /setup?token=<…> from the install output.",
        });
      }
      const consumed = await execute(
        registry,
        adapter,
        locals.ctx,
        "owner_bootstrap_tokens.consume",
        { token },
      );
      if (!consumed.ok) {
        return fail(400, {
          email,
          displayName,
          error: "Bootstrap token invalid, expired, or already used.",
        });
      }
    }

    const result = await execute(registry, adapter, locals.ctx, "users.create_first_owner", {
      email,
      password,
      displayName,
    });
    if (!result.ok) {
      return fail(400, { email, displayName, error: "Setup failed. Is there already an owner?" });
    }
    throw redirect(303, "/login");
  },
};
