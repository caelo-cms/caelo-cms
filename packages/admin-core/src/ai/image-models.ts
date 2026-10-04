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

/** What callers may ask of a model. Reported verbatim to the AI and plugins. */
export interface ImageCapabilities {
  readonly provider: "openai" | "google";
  readonly model: string;
  /** `edit` = change a source image (optionally under a mask). */
  readonly operations: readonly ("generate" | "edit")[];
  readonly references: {
    readonly max: number;
    readonly maxBytesEach: number;
    readonly maxBytesTotal: number;
    readonly mediaTypes: readonly ("image/png" | "image/jpeg" | "image/webp")[];
  };
  /** True when an edit can be limited to a masked region. */
  readonly mask: boolean;
  /** Output shapes accepted as `size`. */
  readonly sizes: readonly ("1024x1024" | "1792x1024" | "1024x1792")[];
  /** Native resolutions accepted as `imageSize` (empty: not selectable). */
  readonly imageSizes: readonly ("1K" | "2K" | "4K")[];
}

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

/**
 * Check a request against a model's capabilities. Returns an AI-actionable
 * reason, or null when the request fits. Run before any reservation.
 */
export function capabilityRefusal(
  caps: ImageCapabilities,
  request: {
    operation: "generate" | "edit";
    references: readonly { bytes: number; mediaType: string }[];
    mask: boolean;
    size?: string;
    imageSize?: string;
  },
): string | null {
  if (!caps.operations.includes(request.operation)) {
    return `${caps.model} cannot ${request.operation} images. Supported: ${caps.operations.join(", ")}.`;
  }
  if (request.mask && !caps.mask) {
    return `${caps.model} cannot limit an edit to a mask. Describe the region in the prompt instead, or configure a model that supports masks.`;
  }
  if (request.references.length > caps.references.max) {
    return `${caps.model} accepts at most ${caps.references.max} reference image(s); ${request.references.length} given.`;
  }
  let total = 0;
  for (const ref of request.references) {
    if (!(caps.references.mediaTypes as readonly string[]).includes(ref.mediaType)) {
      return `${caps.model} accepts reference images as ${caps.references.mediaTypes.join(", ")}; got ${ref.mediaType}.`;
    }
    if (ref.bytes > caps.references.maxBytesEach) {
      return `A reference image is larger than ${caps.references.maxBytesEach} bytes, the limit for ${caps.model}.`;
    }
    total += ref.bytes;
  }
  if (total > caps.references.maxBytesTotal) {
    return `Reference images total ${total} bytes; ${caps.model} accepts ${caps.references.maxBytesTotal}.`;
  }
  if (request.size && !(caps.sizes as readonly string[]).includes(request.size)) {
    return `${caps.model} does not produce ${request.size}. Sizes: ${caps.sizes.join(", ")}.`;
  }
  if (request.imageSize && !(caps.imageSizes as readonly string[]).includes(request.imageSize)) {
    return caps.imageSizes.length === 0
      ? `${caps.model} has no selectable resolution; omit imageSize.`
      : `${caps.model} resolutions: ${caps.imageSizes.join(", ")}.`;
  }
  return null;
}
