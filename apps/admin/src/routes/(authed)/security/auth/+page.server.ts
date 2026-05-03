// SPDX-License-Identifier: MPL-2.0

/**
 * P12 review-pass — Auth plugin Owner config surface.
 * Reads + writes the singleton auth_config row through the auth plugin's
 * `get_auth_config` / `apply_auth_config` ops. AI-proposed config still
 * lands directly today (auth plugin is locked from regen); a future
 * proposal-queue split lands when a real workflow demands it.
 */

import { runPluginOperation } from "@caelo/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { Actions, PageServerLoad } from "./$types";

interface AuthConfig {
  id: string | null;
  signupOpen: boolean;
  passwordMinLength: number;
  updatedAt: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const r = await runPluginOperation({
    pluginSlug: "auth",
    operationName: "get_auth_config",
    args: {},
  });
  if (!r.ok) {
    return {
      config: { id: null, signupOpen: true, passwordMinLength: 8, updatedAt: null } as AuthConfig,
      error: r.error.message,
    };
  }
  return { config: r.value as AuthConfig, error: null };
};

export const actions: Actions = {
  apply: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const signupOpen = form.get("signupOpen") === "on";
    const passwordMinLengthRaw = form.get("passwordMinLength");
    const passwordMinLength = Number.parseInt(
      typeof passwordMinLengthRaw === "string" ? passwordMinLengthRaw : "8",
      10,
    );
    if (Number.isNaN(passwordMinLength) || passwordMinLength < 8 || passwordMinLength > 128) {
      return fail(400, { error: "passwordMinLength must be 8..128" });
    }
    const r = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "apply_auth_config",
      args: { signupOpen, passwordMinLength },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    return { ok: true, message: "Auth config saved." };
  },
};
