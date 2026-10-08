// SPDX-License-Identifier: MPL-2.0

/**
 * #593 — purpose → model resolution for plugin AI calls.
 *
 * A plugin declares what a `ctx.ai.complete` call is for (`purpose`); it
 * never names a model. The Owner may pick a model per purpose on the
 * active provider (today: translation, stored in
 * `ai_providers.translation_model`). Resolution order:
 *   1. the purpose's stored model, when the purpose is known and a model
 *      is stored for it;
 *   2. otherwise `null` — the caller runs the call on the chat model.
 * A stored NULL is the explicit "same as the chat model" setting, and an
 * unknown purpose has no setting to read, so both land on step 2.
 */

/** The per-purpose model settings of the active provider row. */
export interface PurposeModels {
  /** `ai_providers.translation_model`; null = same as the chat model. */
  readonly translationModel: string | null;
}

/**
 * The model configured for `purpose`, or null when the call should run on
 * the chat model.
 */
export function modelForPurpose(purpose: string | undefined, models: PurposeModels): string | null {
  switch (purpose) {
    case "translation":
      return models.translationModel;
    default:
      return null;
  }
}
