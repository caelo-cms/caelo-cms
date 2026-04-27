// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_providers.list", {});
  const providers = r.ok
    ? (
        r.value as {
          providers: {
            id: string;
            name: "anthropic" | "openai" | "google" | "local-openai-compat";
            displayName: string;
            config: Record<string, unknown>;
            isActive: boolean;
          }[];
        }
      ).providers
    : [];
  // P5 ships only the Anthropic adapter; P16 adds the others. Show the
  // single row + key-status indicator (key itself is in env, not the DB).
  const apiKeySet = Boolean(process.env["ANTHROPIC_API_KEY"]);
  return { providers, apiKeySet };
};

export const actions: Actions = {
  set: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const model = String(form.get("model") ?? "claude-opus-4-7").trim();
    const result = await execute(registry, adapter, locals.ctx, "ai_providers.set", {
      name: "anthropic",
      displayName: "AI provider",
      config: { model },
      isActive: true,
    });
    if (!result.ok) return fail(400, { error: "Could not save provider config." });
    return { ok: true };
  },
};
