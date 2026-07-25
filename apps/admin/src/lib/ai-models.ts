// SPDX-License-Identifier: MPL-2.0

/**
 * Shared model catalogue for the two AI-credential entry points — the
 * first-run wizard (`(auth)/welcome/ai`) and the Owner security panel
 * (`(authed)/security/ai`). Both import from here so the option list
 * and per-provider default live in exactly one place.
 *
 * The `id` values are the exact provider model-id strings threaded into
 * `ai_providers.config.model`; the resolver reads that key
 * (`provider-resolver.ts`) with `DEFAULT_MODEL[row.name]` as the
 * fallback. Keep the Anthropic default at `claude-sonnet-5` in lockstep
 * with the resolver's default.
 */

/** A selectable model: the config value plus the human-facing label. */
export type ModelOption = {
  /** Exact model-id string persisted to `config.model`. */
  id: string;
  /** Label shown in the picker. */
  label: string;
};

/**
 * Provider → its selectable models. Anthropic (Claude) is the primary,
 * best-tested provider and leads the list. Providers not present here
 * (e.g. `local-openai-compat`) take a free-text model field instead.
 */
export const MODEL_OPTIONS: Record<string, readonly ModelOption[]> = {
  anthropic: [
    { id: "claude-sonnet-5", label: "Sonnet 5 (recommended)" },
    { id: "claude-opus-4-8", label: "Opus 4.8 (most capable)" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5 (fastest/cheapest)" },
  ],
  openai: [{ id: "gpt-4o", label: "GPT-4o" }],
  google: [{ id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" }],
} as const;

/** Per-provider default model id (the pre-selected option). */
export const DEFAULT_MODEL_ID: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  google: "gemini-1.5-pro",
} as const;

/** Short helper copy shown beneath the Model picker. */
export const MODEL_HELPER_TEXT =
  "Claude's Sonnet 5 is the default — a good balance of quality and cost.";

/**
 * Models for a provider, or an empty list for providers that use a
 * free-text model field (no curated catalogue).
 */
export function modelsForProvider(provider: string): readonly ModelOption[] {
  return MODEL_OPTIONS[provider] ?? [];
}

/**
 * Default model id for a provider, falling back to the first catalogued
 * option and finally to the empty string when nothing is known.
 */
export function defaultModelForProvider(provider: string): string {
  return DEFAULT_MODEL_ID[provider] ?? MODEL_OPTIONS[provider]?.[0]?.id ?? "";
}
