// SPDX-License-Identifier: MPL-2.0

/**
 * First-run AI wizard — the focused "pick a provider, paste a key,
 * start chatting" dialog the (authed) layout redirects to when no AI
 * provider is configured yet. Operator feedback (2026-07-12): landing
 * on the full /security/ai management page right after the first
 * login is overwhelming; the first run should be a two-field dialog
 * that ends in the chat. /security/ai stays the management surface
 * (env keys, local models, output ceilings, switching providers).
 *
 * Lives in the (auth) route group for the same centered-card layout
 * as /login and /setup, but requires a signed-in Owner — it writes
 * provider config.
 */

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

// The wizard offers the three hosted providers. local-openai-compat
// needs a base URL and model tuning — that's /security/ai territory,
// linked from the wizard footer.
const WIZARD_PROVIDERS = ["anthropic", "openai", "google"] as const;
type WizardProvider = (typeof WIZARD_PROVIDERS)[number];

// Same defaults as /security/ai — keep in sync until a shared
// provider-catalog module exists.
const DEFAULT_MODEL: Record<WizardProvider, string> = {
  anthropic: "claude-opus-4-7",
  openai: "gpt-4o",
  google: "gemini-1.5-pro",
};

const DISPLAY_NAME: Record<WizardProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google (Gemini)",
};

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, "/login");
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_providers.any_configured", {});
  if (r.ok && (r.value as { anyConfigured: boolean }).anyConfigured) {
    // Already set up (another tab finished the wizard, or env keys
    // exist) — straight to the chat.
    throw redirect(303, "/edit");
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) throw redirect(303, "/login");
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const name = String(form.get("provider") ?? "").trim() as WizardProvider;
    if (!WIZARD_PROVIDERS.includes(name)) {
      // Uniform shape with the fails below so ActionData keeps
      // `provider` on every variant.
      return fail(400, { provider: null, error: "Pick one of the listed providers." });
    }
    const apiKey = String(form.get("apiKey") ?? "").trim();
    if (!apiKey) {
      return fail(400, { provider: name, error: "Paste an API key to continue." });
    }

    const result = await execute(registry, adapter, locals.ctx, "ai_providers.set", {
      name,
      displayName: DISPLAY_NAME[name],
      config: { model: DEFAULT_MODEL[name] },
      isActive: true,
      apiKey,
    });
    if (!result.ok) {
      return fail(400, {
        provider: name,
        error: "Could not save the provider. Check the key and try again.",
      });
    }
    // Wizard done — land in the chat, where the site actually gets built.
    throw redirect(303, "/edit");
  },
};
