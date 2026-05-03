// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  "local-openai-compat": "LOCAL_OPENAI_BASE_URL",
};

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-opus-4-7",
  openai: "gpt-4o",
  google: "gemini-1.5-pro",
  "local-openai-compat": "qwen2.5",
};

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_providers.list", {});
  type Row = {
    id: string;
    name: "anthropic" | "openai" | "google" | "local-openai-compat";
    displayName: string;
    config: Record<string, unknown>;
    isActive: boolean;
  };
  const rows = r.ok ? ((r.value as { providers: Row[] }).providers ?? []) : [];

  // Surface every supported provider, even if unconfigured — Owner needs
  // the row to flip activate. `keyEnv` is the secret-source the runtime
  // reads at boot; absence means the provider can't actually be used.
  const KNOWN: Array<Row["name"]> = ["anthropic", "openai", "google", "local-openai-compat"];
  const byName = new Map(rows.map((r) => [r.name, r]));
  const providers = KNOWN.map((name) => {
    const row = byName.get(name);
    const envKey = PROVIDER_KEY_ENV[name];
    return {
      name,
      displayName: row?.displayName ?? prettyName(name),
      isActive: row?.isActive ?? false,
      configured: Boolean(row),
      apiKeySet: envKey ? Boolean(process.env[envKey]) : false,
      keyEnv: envKey ?? null,
      model:
        (typeof row?.config["model"] === "string" ? (row.config["model"] as string) : null) ??
        DEFAULT_MODEL[name] ??
        "",
      baseUrl:
        typeof row?.config["baseUrl"] === "string" ? (row.config["baseUrl"] as string) : null,
    };
  });

  return { providers };
};

function prettyName(n: string): string {
  switch (n) {
    case "anthropic":
      return "Anthropic (Claude)";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google (Gemini)";
    case "local-openai-compat":
      return "Local OpenAI-compatible";
    default:
      return n;
  }
}

export const actions: Actions = {
  set: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const name = String(form.get("name") ?? "").trim() as
      | "anthropic"
      | "openai"
      | "google"
      | "local-openai-compat";
    if (!["anthropic", "openai", "google", "local-openai-compat"].includes(name)) {
      return fail(400, { error: "unknown provider" });
    }
    const model = String(form.get("model") ?? "").trim();
    const baseUrl = String(form.get("baseUrl") ?? "").trim();
    const isActive = form.get("isActive") === "1";
    const config: Record<string, unknown> = { model };
    if (baseUrl) config["baseUrl"] = baseUrl;

    const result = await execute(registry, adapter, locals.ctx, "ai_providers.set", {
      name,
      displayName: prettyName(name),
      config,
      isActive,
    });
    if (!result.ok) return fail(400, { error: "Could not save provider config." });
    return { ok: true, providerName: name };
  },
};
