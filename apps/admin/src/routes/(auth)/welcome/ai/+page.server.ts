// SPDX-License-Identifier: MPL-2.0

/**
 * First-run AI wizard — the focused dialog the (authed) layout redirects to
 * until the Owner decided how this install gets its AI. Operator feedback
 * (2026-07-12): landing on the full /settings/ai management page right after
 * the first login is overwhelming; the first run should be a two-field
 * dialog that ends in the chat. /settings/ai stays the management surface
 * (env keys, local models, output ceilings, switching providers).
 *
 * #1460 — the preselected first option is no key at all: the install works
 * through an external agent (Power-MCP), nothing is stored but that choice,
 * and the wizard ends at /settings/mcp, where the next step is a token.
 *
 * Lives in the (auth) route group for the same centered-card layout
 * as /login and /setup, but requires a signed-in Owner — it writes
 * provider config.
 */

import { execute } from "@caelo-cms/query-api";
import type { InstallAiMode } from "@caelo-cms/shared";
import { fail, redirect } from "@sveltejs/kit";
import { defaultModelForProvider, modelsForProvider } from "#lib/ai-models.js";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

// The wizard offers the three hosted providers. local-openai-compat
// needs a base URL and model tuning — that's /settings/ai territory,
// linked from the wizard footer.
const WIZARD_PROVIDERS = ["anthropic", "openai", "google"] as const;
type WizardProvider = (typeof WIZARD_PROVIDERS)[number];

/** The form value of the no-key option, next to the provider names. */
const MCP_ONLY_CHOICE = "mcp_only";

const DISPLAY_NAME: Record<WizardProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google (Gemini)",
};

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, "/login");
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_providers.get_mode", {});
  const mode = r.ok ? (r.value as { mode: InstallAiMode }).mode : "unset";
  // Already decided (another tab finished the wizard, or env keys exist):
  // on to where that decision leads.
  if (mode === "provider") throw redirect(303, "/edit");
  if (mode === "mcp_only") throw redirect(303, "/settings/mcp");
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) throw redirect(303, "/login");
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const choice = String(form.get("provider") ?? "").trim();
    if (choice === MCP_ONLY_CHOICE) {
      const chosen = await execute(registry, adapter, locals.ctx, "ai_providers.set_mcp_only", {});
      if (!chosen.ok) {
        const error = "message" in chosen.error ? chosen.error.message : chosen.error.kind;
        return fail(400, { provider: MCP_ONLY_CHOICE, error });
      }
      // The next step of this path is a token for the agent.
      throw redirect(303, "/settings/mcp");
    }

    const name = choice as WizardProvider;
    if (!WIZARD_PROVIDERS.includes(name)) {
      // Uniform shape with the fails below so ActionData keeps
      // `provider` on every variant.
      return fail(400, { provider: null, error: "Pick one of the listed options." });
    }
    const apiKey = String(form.get("apiKey") ?? "").trim();
    if (!apiKey) {
      return fail(400, { provider: name, error: "Paste an API key to continue." });
    }

    // Thread the picked model into config.model. Validate against the
    // provider's curated list so a tampered form can't inject an
    // arbitrary string; fall back to the provider default otherwise.
    const submittedModel = String(form.get("model") ?? "").trim();
    const model = modelsForProvider(name).some((m) => m.id === submittedModel)
      ? submittedModel
      : defaultModelForProvider(name);

    const result = await execute(registry, adapter, locals.ctx, "ai_providers.set", {
      name,
      displayName: DISPLAY_NAME[name],
      config: { model },
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
