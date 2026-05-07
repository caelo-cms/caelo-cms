// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

const KNOWN_PROVIDERS = ["anthropic", "openai", "google", "local-openai-compat"] as const;
type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

const DEFAULT_MODEL: Record<KnownProvider, string> = {
  anthropic: "claude-opus-4-7",
  openai: "gpt-4o",
  google: "gemini-1.5-pro",
  "local-openai-compat": "qwen2.5",
};

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_providers.list", {});
  type Row = {
    id: string;
    name: KnownProvider;
    displayName: string;
    config: Record<string, unknown>;
    isActive: boolean;
    apiKeySource: "db" | "env" | null;
    apiKeySetAt: string | null;
  };
  const rows = r.ok ? ((r.value as { providers: Row[] }).providers ?? []) : [];

  // Surface every supported provider, even if unconfigured — Owner needs
  // the row to flip activate. `apiKeySource` is computed by the op so
  // there's one source of truth.
  const byName = new Map(rows.map((r) => [r.name, r]));
  const providers = KNOWN_PROVIDERS.map((name) => {
    const row = byName.get(name);
    return {
      name,
      displayName: row?.displayName ?? prettyName(name),
      isActive: row?.isActive ?? false,
      configured: Boolean(row),
      apiKeySource: (row?.apiKeySource ?? null) as "db" | "env" | null,
      apiKeySetAt: row?.apiKeySetAt ?? null,
      model:
        (typeof row?.config.model === "string" ? (row.config.model as string) : null) ??
        DEFAULT_MODEL[name] ??
        "",
      baseUrl: typeof row?.config.baseUrl === "string" ? (row.config.baseUrl as string) : null,
      // v0.2.53 — Per-provider output ceiling stored alongside model.
      // null means "use the chat-runner default of 16384". Range
      // enforced at write-time: 1024-200000 (covers every modern
      // model's max output without permitting nonsensical values).
      maxOutputTokens:
        typeof row?.config.maxOutputTokens === "number"
          ? (row.config.maxOutputTokens as number)
          : null,
    };
  });

  // First-run banner trigger from the +layout.server.ts redirect.
  const firstRun = url.searchParams.get("firstRun") === "1";

  return { providers, firstRun };
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

    const name = String(form.get("name") ?? "").trim() as KnownProvider;
    if (!KNOWN_PROVIDERS.includes(name)) {
      return fail(400, { error: "unknown provider" });
    }
    const model = String(form.get("model") ?? "").trim();
    const baseUrl = String(form.get("baseUrl") ?? "").trim();
    const apiKeyRaw = String(form.get("apiKey") ?? "");
    // Empty input means "leave existing key untouched" — Owner edits
    // model / baseUrl without re-pasting the key. Trimmed-empty also
    // counts as no-change.
    const apiKey = apiKeyRaw.trim().length > 0 ? apiKeyRaw : undefined;
    const isActive = form.get("isActive") === "1";
    const config: Record<string, unknown> = { model };
    if (baseUrl) config.baseUrl = baseUrl;
    // v0.2.53 — Optional per-provider output ceiling. Empty input clears
    // the override (resolver falls back to chat-runner's 16384 default).
    // Out-of-range or non-numeric input is rejected here so the resolver
    // never sees garbage data. Range: 1024-200000.
    const maxOutputTokensRaw = String(form.get("maxOutputTokens") ?? "").trim();
    if (maxOutputTokensRaw.length > 0) {
      const n = Number(maxOutputTokensRaw);
      if (!Number.isInteger(n) || n < 1024 || n > 200000) {
        return fail(400, {
          error: "Max output tokens must be a whole number between 1024 and 200000.",
        });
      }
      config.maxOutputTokens = n;
    }

    const result = await execute(registry, adapter, locals.ctx, "ai_providers.set", {
      name,
      displayName: prettyName(name),
      config,
      isActive,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
    if (!result.ok) return fail(400, { error: "Could not save provider config." });
    const apiKeyChanged = (result.value as { apiKeyChanged: boolean }).apiKeyChanged;
    return { ok: true, providerName: name, apiKeyChanged };
  },

  clear_key: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const name = String(form.get("name") ?? "").trim() as KnownProvider;
    if (!KNOWN_PROVIDERS.includes(name)) {
      return fail(400, { error: "unknown provider" });
    }
    const result = await execute(registry, adapter, locals.ctx, "ai_providers.clear_key", { name });
    if (!result.ok) return fail(400, { error: "Could not clear key." });
    return { ok: true, providerName: name, cleared: true };
  },
};
