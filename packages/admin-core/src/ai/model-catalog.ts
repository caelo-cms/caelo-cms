// SPDX-License-Identifier: MPL-2.0

/**
 * Typed access to `model-catalog.json` — the ONE place curated model ids
 * live. The admin model picker, the resolver's per-provider default, the
 * turn-completeness judge and the small-model helpers all read from here,
 * so the weekly refresh (`scripts/refresh-model-catalog.ts`) only has to
 * rewrite the JSON.
 *
 * Adding a model id here is not enough on its own: a new model also needs
 * an `ai_pricing` row (otherwise its calls are flagged `unpriced`) and, for
 * Anthropic, a look at the capability predicates in `providers/anthropic.ts`.
 */

import catalog from "./model-catalog.json" with { type: "json" };

export type CatalogProvider = "anthropic" | "openai" | "google";
export type ModelRole = "default" | "capable" | "fast";

export interface CatalogSlot {
  readonly role: ModelRole;
  /** Short qualifier shown after the label in the picker ("recommended"). */
  readonly note: string;
  /** Regex (source) the refresh script uses to pick the newest id. */
  readonly match: string;
  readonly id: string;
  readonly label: string;
}

export const MODEL_CATALOG = catalog.providers as Readonly<
  Record<CatalogProvider, { readonly slots: readonly CatalogSlot[] }>
>;

/** Curated slots of a provider, in picker order. */
export function catalogSlots(provider: CatalogProvider): readonly CatalogSlot[] {
  return MODEL_CATALOG[provider].slots;
}

/** Model id for a role. Throws when the catalog has no such slot — no silent substitute. */
export function catalogModel(provider: CatalogProvider, role: ModelRole): string {
  const slot = MODEL_CATALOG[provider].slots.find((s) => s.role === role);
  if (!slot) throw new Error(`model-catalog.json: provider "${provider}" has no "${role}" slot`);
  return slot.id;
}
