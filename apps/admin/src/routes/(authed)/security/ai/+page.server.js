// SPDX-License-Identifier: MPL-2.0
import { checkProviderKeyHealth } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
const KNOWN_PROVIDERS = ["anthropic", "openai", "google", "local-openai-compat"];
const DEFAULT_MODEL = {
    anthropic: "claude-sonnet-5",
    openai: "gpt-4o",
    google: "gemini-1.5-pro",
    "local-openai-compat": "qwen2.5",
};
export const load = async ({ locals, url }) => {
    requirePermission(locals, "settings.read");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "ai_providers.list", {});
    const rows = r.ok ? (r.value.providers ?? []) : [];
    // Surface every supported provider, even if unconfigured — Owner needs
    // the row to flip activate. `apiKeySource` is computed by the op so
    // there's one source of truth.
    const byName = new Map(rows.map((r) => [r.name, r]));
    // v0.2.82 — probe each db-sourced row's encryption health so the
    // UI can show a specific banner when the ciphertext is unreadable
    // (vs the misleading "Encrypted key set" badge that fired even
    // when decrypt failed). Post-KEK-rotation operators saw "Encrypted"
    // + "Save successful" + chat saying "AI provider not configured" —
    // the banner closes the loop with "this key was sealed under a
    // rotated KEK; paste it again to fix".
    const healthByName = new Map();
    await Promise.all(KNOWN_PROVIDERS.map(async (name) => {
        try {
            healthByName.set(name, await checkProviderKeyHealth(name));
        }
        catch {
            // Probe errors shouldn't block the page; fall back to
            // "no_key" so the row still renders.
            healthByName.set(name, "no_key");
        }
    }));
    const providers = KNOWN_PROVIDERS.map((name) => {
        const row = byName.get(name);
        return {
            name,
            displayName: row?.displayName ?? prettyName(name),
            isActive: row?.isActive ?? false,
            configured: Boolean(row),
            apiKeySource: (row?.apiKeySource ?? null),
            apiKeySetAt: row?.apiKeySetAt ?? null,
            keyHealth: healthByName.get(name) ?? "no_key",
            model: (typeof row?.config.model === "string" ? row.config.model : null) ??
                DEFAULT_MODEL[name] ??
                "",
            baseUrl: typeof row?.config.baseUrl === "string" ? row.config.baseUrl : null,
            // v0.2.53 — Per-provider output ceiling stored alongside model.
            // null means "use the chat-runner default of 16384". Range
            // enforced at write-time: 1024-200000 (covers every modern
            // model's max output without permitting nonsensical values).
            maxOutputTokens: typeof row?.config.maxOutputTokens === "number"
                ? row.config.maxOutputTokens
                : null,
        };
    });
    // First-run banner trigger from the +layout.server.ts redirect.
    const firstRun = url.searchParams.get("firstRun") === "1";
    return { providers, firstRun };
};
function prettyName(n) {
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
export const actions = {
    set: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const name = String(form.get("name") ?? "").trim();
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
        // issue #306 — START from the row's existing config so keys this form
        // does not manage (e.g. `modelTiers`, the tier→model routing map) are
        // preserved instead of silently wiped on every save. The form-managed
        // keys below then overwrite/clear their own slots explicitly.
        const existing = await execute(registry, adapter, locals.ctx, "ai_providers.list", {});
        const existingConfig = (existing.ok &&
            existing.value.providers.find((p) => p.name === name)?.config) ||
            {};
        const config = { ...existingConfig, model };
        if (baseUrl)
            config.baseUrl = baseUrl;
        else
            delete config.baseUrl;
        delete config.maxOutputTokens;
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
        if (!result.ok)
            return fail(400, { error: "Could not save provider config." });
        const apiKeyChanged = result.value.apiKeyChanged;
        return { ok: true, providerName: name, apiKeyChanged };
    },
    clear_key: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const name = String(form.get("name") ?? "").trim();
        if (!KNOWN_PROVIDERS.includes(name)) {
            return fail(400, { error: "unknown provider" });
        }
        const result = await execute(registry, adapter, locals.ctx, "ai_providers.clear_key", { name });
        if (!result.ok)
            return fail(400, { error: "Could not clear key." });
        return { ok: true, providerName: name, cleared: true };
    },
};
