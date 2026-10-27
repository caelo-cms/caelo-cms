// SPDX-License-Identifier: MPL-2.0

/**
 * P12 review-pass — Auth plugin Owner config surface.
 * Reads + writes the singleton auth_config row through the auth plugin's
 * `get_auth_config` / `apply_auth_config` ops. AI-proposed config still
 * lands directly today (auth plugin is locked from regen); a future
 * proposal-queue split lands when a real workflow demands it.
 */

import { runPluginOperation } from "@caelo-cms/plugin-host";
import { fail } from "@sveltejs/kit";
import { authConfigView, parsePasswordMinLength } from "#lib/server/auth-config.js";
import { requirePermission } from "#lib/server/guards.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const r = await runPluginOperation({
    invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
    pluginSlug: "auth",
    operationName: "get_auth_config",
    args: {},
  });
  return authConfigView(r);
};

export const actions: Actions = {
  apply: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const signupOpen = form.get("signupOpen") === "on";
    const passwordMinLength = parsePasswordMinLength(form.get("passwordMinLength"));
    if (typeof passwordMinLength === "string") return fail(400, { error: passwordMinLength });
    const r = await runPluginOperation({
      invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
      pluginSlug: "auth",
      operationName: "apply_auth_config",
      args: { signupOpen, passwordMinLength },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    return { ok: true, message: "Auth config saved." };
  },
};
