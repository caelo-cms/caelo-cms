// SPDX-License-Identifier: MPL-2.0

/** Google image models, curated against https://ai.google.dev/gemini-api/docs/models
 * on 2026-09-11. Chat models live in admin-core's model-catalog.json; image-only
 * models stay out of it because they cannot call tools. Exact IDs are
 * intentional; automatic latest aliases could change behaviour.
 */
export const GOOGLE_IMAGE_MODELS = [
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2 (Gemini 3.1 Flash Image)" },
  { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite" },
  { id: "gemini-3-pro-image", label: "Nano Banana Pro (Gemini 3 Pro Image)" },
  { id: "gemini-2.5-flash-image", label: "Nano Banana (Gemini 2.5 Flash Image)" },
] as const;
