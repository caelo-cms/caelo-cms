// SPDX-License-Identifier: MPL-2.0

/**
 * What each supported image model can do and what it costs (#527, #529).
 * One table for every image call — the chat's `generate_image` and the
 * plugin `ctx.images` broker reserve, validate and settle from the same
 * profile, and `describe` / `get_image_capabilities` report it.
 *
 * Image cost depends on the output (resolution, tokens), not on a flat
 * per-1K-token rate, so it lives here, with its source, instead of in
 * `ai_pricing`. `reserveMicrocents` is the conservative upper bound held
 * while a request is in flight; the settled cost replaces it.
 *
 * An unknown model has no profile: callers refuse it before any paid call
 * (CLAUDE.md §2 — no guessed capabilities or prices).
 *
 * Money unit: microcents (1e-8 USD). Token rates are USD per 1M tokens.
 * Sources: ai.google.dev/gemini-api/docs/pricing and
 * openai.com/api/pricing (checked 2026-09-14).
 */

import type { ImageCapabilities } from "@caelo-cms/shared";

type Pricing =
  | {
      kind: "tokens";
      /** USD per 1M input / output tokens. */
      input: number;
      output: number;
      reserveMicrocents: number;
    }
  | {
      kind: "per-image";
      /** Microcents per image by quality and shape. */
      standard: { square: number; wide: number };
      hd: { square: number; wide: number };
      reserveMicrocents: number;
    }
  | { kind: "free"; reserveMicrocents: number };

interface ImageModelProfile {
  capabilities: ImageCapabilities;
  pricing: Pricing;
}

const PNG_JPEG_WEBP = ["image/png", "image/jpeg", "image/webp"] as const;
const SHAPES = ["1024x1024", "1792x1024", "1024x1792"] as const;

function gemini(
  model: string,
  refs: number,
  imageSizes: ImageCapabilities["imageSizes"],
  pricing: Pricing,
): ImageModelProfile {
  return {
    capabilities: {
      provider: "google",
      model,
      // Gemini edits by taking the source image as the first reference.
      operations: ["generate", "edit"],
      references: {
        max: refs,
        maxBytesEach: 10_000_000,
        maxBytesTotal: 20_000_000,
        mediaTypes: PNG_JPEG_WEBP,
      },
      mask: false,
      sizes: SHAPES,
      imageSizes,
    },
    pricing,
  };
}

const PROFILES: Record<string, ImageModelProfile> = {
  "gemini-3.1-flash-image": gemini("gemini-3.1-flash-image", 14, ["1K", "2K", "4K"], {
    kind: "tokens",
    input: 0.5,
    output: 60,
    reserveMicrocents: 100_000_000,
  }),
  "gemini-3.1-flash-lite-image": gemini("gemini-3.1-flash-lite-image", 14, ["1K", "2K", "4K"], {
    kind: "tokens",
    input: 0.25,
    output: 30,
    reserveMicrocents: 100_000_000,
  }),
  "gemini-3-pro-image": gemini("gemini-3-pro-image", 14, ["1K", "2K", "4K"], {
    kind: "tokens",
    input: 2,
    output: 120,
    reserveMicrocents: 200_000_000,
  }),
  "gemini-2.5-flash-image": gemini("gemini-2.5-flash-image", 3, [], {
    kind: "tokens",
    input: 0.3,
    output: 30,
    reserveMicrocents: 10_000_000,
  }),
  // gpt-image-1 generates and edits; an edit takes the source plus up to 15
  // more images and an optional PNG mask. Shapes are mapped by the adapter
  // (1792x1024 → 1536x1024, 1024x1792 → 1024x1536).
  "gpt-image-1": {
    capabilities: {
      provider: "openai",
      model: "gpt-image-1",
      operations: ["generate", "edit"],
      references: {
        max: 16,
        maxBytesEach: 25_000_000,
        maxBytesTotal: 50_000_000,
        mediaTypes: PNG_JPEG_WEBP,
      },
      mask: true,
      sizes: SHAPES,
      imageSizes: [],
    },
    pricing: { kind: "tokens", input: 10, output: 40, reserveMicrocents: 30_000_000 },
  },
  "dall-e-3": {
    capabilities: {
      provider: "openai",
      model: "dall-e-3",
      operations: ["generate"],
      references: { max: 0, maxBytesEach: 0, maxBytesTotal: 0, mediaTypes: [] },
      mask: false,
      sizes: SHAPES,
      imageSizes: [],
    },
    pricing: {
      kind: "per-image",
      standard: { square: 4_000_000, wide: 8_000_000 },
      hd: { square: 8_000_000, wide: 12_000_000 },
      reserveMicrocents: 12_000_000,
    },
  },
};

/** The test-only fake provider (isFakeImageEnabled): free, generous limits. */
const FAKE_PROFILE: ImageModelProfile = {
  capabilities: {
    provider: "openai",
    model: "fake-image",
    operations: ["generate", "edit"],
    references: {
      max: 14,
      maxBytesEach: 10_000_000,
      maxBytesTotal: 20_000_000,
      mediaTypes: PNG_JPEG_WEBP,
    },
    mask: true,
    sizes: SHAPES,
    imageSizes: ["1K", "2K", "4K"],
  },
  pricing: { kind: "free", reserveMicrocents: 1 },
};

function profile(model: string): ImageModelProfile | null {
  if (model === "fake-image") return FAKE_PROFILE;
  return PROFILES[model] ?? null;
}

export { capabilityRefusal, type ImageCapabilities } from "@caelo-cms/shared";

/** The models with a profile — named in refusals so the fix is obvious. */
export const SUPPORTED_IMAGE_MODELS: readonly string[] = Object.keys(PROFILES);

/** Capabilities of a model, or null when it has no profile. */
export function imageCapabilities(model: string): ImageCapabilities | null {
  return profile(model)?.capabilities ?? null;
}

/** The amount reserved while a request for this model is in flight. */
export function imageReserveMicrocents(model: string): number | null {
  return profile(model)?.pricing.reserveMicrocents ?? null;
}

/**
 * The settled cost of a finished request. Token-priced models use the
 * reported usage; when the provider reports none, the reservation stands
 * (never under-charge an unknown amount).
 */
export function settleImageCostMicrocents(
  model: string,
  request: { size?: string; quality?: string },
  usage?: { inputTokens: number; outputTokens: number },
): number {
  const p = profile(model);
  if (!p) throw new Error(`image model ${model} has no pricing profile`);
  const pricing = p.pricing;
  switch (pricing.kind) {
    case "free":
      return 0;
    case "per-image": {
      const tier = request.quality === "hd" ? pricing.hd : pricing.standard;
      return request.size && request.size !== "1024x1024" ? tier.wide : tier.square;
    }
    case "tokens":
      return usage && usage.outputTokens > 0
        ? Math.ceil((usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) * 100)
        : pricing.reserveMicrocents;
  }
}
