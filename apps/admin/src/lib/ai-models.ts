// SPDX-License-Identifier: MPL-2.0

/**
 * Shared model catalogue for the two AI-credential entry points — the
 * first-run wizard (`(auth)/welcome/ai`) and the Owner security panel
 * (`(authed)/security/ai`). Both import from here so the option list
 * and per-provider default live in exactly one place.
 *
 * The ids come from `@caelo-cms/admin-core/model-catalog` (the curated
 * `model-catalog.json`, refreshed weekly by `scripts/refresh-model-catalog.ts`),
 * the same source the resolver's per-provider default reads — so picker
 * and resolver cannot drift apart. The `id` values are the exact provider
 * model-id strings threaded into `ai_providers.config.model`.
 */

import {
  type CatalogProvider,
  catalogModel,
  catalogSlots,
  MODEL_CATALOG,
} from "@caelo-cms/admin-core/model-catalog";

/** A selectable model: the config value plus the human-facing label. */
export type ModelOption = {
  /** Exact model-id string persisted to `config.model`. */
  id: string;
  /** Label shown in the picker. */
  label: string;
};

const CATALOG_PROVIDERS = Object.keys(MODEL_CATALOG) as CatalogProvider[];

/**
 * Provider → its selectable models. Anthropic (Claude) is the primary,
 * best-tested provider and leads the list. Providers not present here
 * (e.g. `local-openai-compat`) take a free-text model field instead.
 */
export const MODEL_OPTIONS: Record<string, readonly ModelOption[]> = Object.fromEntries(
  CATALOG_PROVIDERS.map((provider) => [
    provider,
    catalogSlots(provider).map((slot) => ({
      id: slot.id,
      label: slot.note ? `${slot.label} (${slot.note})` : slot.label,
    })),
  ]),
);

/** Per-provider default model id (the pre-selected option). */
export const DEFAULT_MODEL_ID: Record<string, string> = Object.fromEntries(
  CATALOG_PROVIDERS.map((provider) => [provider, catalogModel(provider, "default")]),
);

/** Short helper copy shown beneath the Model picker. */
export const MODEL_HELPER_TEXT = `${
  catalogSlots("anthropic").find((s) => s.role === "default")?.label
} is the default — a good balance of quality and cost.`;

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
