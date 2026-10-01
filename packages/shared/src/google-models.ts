// SPDX-License-Identifier: MPL-2.0

/** Curated against https://ai.google.dev/gemini-api/docs/models on 2026-09-11.
 * Keep image-only models out of the chat picker: they cannot call tools.
 * Exact IDs are intentional; automatic latest aliases could change behaviour.
 */
export const GOOGLE_CHAT_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
] as const;
export const DEFAULT_GOOGLE_CHAT_MODEL = "gemini-3.8-flash";
export const GOOGLE_IMAGE_MODELS = [
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2 (Gemini 3.1 Flash Image)" },
  { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite" },
  { id: "gemini-3-pro-image", label: "Nano Banana Pro (Gemini 3 Pro Image)" },
  { id: "gemini-2.5-flash-image", label: "Nano Banana (Gemini 2.5 Flash Image)" },
] as const;
