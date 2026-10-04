// SPDX-License-Identifier: MPL-2.0

/**
 * Image model capabilities (#529) and the one check every caller runs
 * before a paid image request — the chat's generate_image/edit_image
 * (admin-core) and the plugin `ctx.images` broker (plugin-host) alike.
 * Profiles per model live in admin-core/src/ai/image-models.ts.
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

/** The fields the check reads — satisfied by ImageCapabilities and by the
 *  plugin SDK's structurally identical PluginImageCapabilities. */
export interface ImageCapabilityLimits {
  readonly model: string;
  readonly operations: readonly string[];
  readonly references: {
    readonly max: number;
    readonly maxBytesEach: number;
    readonly maxBytesTotal: number;
    readonly mediaTypes: readonly string[];
  };
  readonly mask: boolean;
  readonly sizes: readonly string[];
  readonly imageSizes: readonly string[];
}

/**
 * Check a request against a model's capabilities. Returns an AI-actionable
 * reason, or null when the request fits. Run before any reservation.
 */
export function capabilityRefusal(
  caps: ImageCapabilityLimits,
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
    if (!caps.references.mediaTypes.includes(ref.mediaType)) {
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
  if (request.size && !caps.sizes.includes(request.size)) {
    return `${caps.model} does not produce ${request.size}. Sizes: ${caps.sizes.join(", ")}.`;
  }
  if (request.imageSize && !caps.imageSizes.includes(request.imageSize)) {
    return caps.imageSizes.length === 0
      ? `${caps.model} has no selectable resolution; omit imageSize.`
      : `${caps.model} resolutions: ${caps.imageSizes.join(", ")}.`;
  }
  return null;
}
