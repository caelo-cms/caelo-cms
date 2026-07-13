// SPDX-License-Identifier: MPL-2.0

/**
 * run #10 D4 — pure "why is this variant missing?" logic shared by
 * `media.regenerate_variants` and its per-asset result report.
 *
 * The pipeline (media/pipeline.ts) deliberately skips WebP breakpoints
 * the source cannot satisfy (no upscaling), skips ALL WebP variants for
 * animated GIFs, and emits only `orig` for non-raster kinds. Those are
 * design decisions, not failures — this module tells the two cases
 * apart so a regenerate run can report "regenerated" vs "nothing to
 * regenerate, and here is why" instead of looping forever on assets
 * that can never grow a webp-800.
 */

import {
  MEDIA_VARIANT_TAGS,
  MEDIA_VARIANT_WIDTHS,
  type MediaVariantTag,
} from "@caelo-cms/shared";

/** Raster mimes the pipeline derives WebP variants for. */
const RASTER_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export interface VariantGap {
  /** Ladder tags the pipeline SHOULD emit for this asset but that are absent. */
  readonly missing: readonly MediaVariantTag[];
  /**
   * Non-null when the asset can never gain more ladder variants —
   * explains the skip in operator/AI-readable words (used verbatim in
   * the regenerate result). Null when `missing` is non-empty (a
   * regenerate run is expected to close the gap).
   */
  readonly skipReason: string | null;
}

/**
 * Compare an asset's EXPECTED ladder (from mime + intrinsic width)
 * against the variant tags that exist on it.
 *
 * @param args.mime stored mime of the asset.
 * @param args.width intrinsic width in px; null for vector/unknown kinds.
 * @param args.existingVariants variant tags present in `media_variants`.
 */
export function computeVariantGap(args: {
  mime: string;
  width: number | null;
  existingVariants: readonly string[];
}): VariantGap {
  const existing = new Set(args.existingVariants);

  if (!RASTER_MIMES.has(args.mime)) {
    return {
      missing: [],
      skipReason: `non-raster mime ${args.mime} only ever gets 'orig' — reference /orig in module HTML`,
    };
  }
  if (args.width === null) {
    // A raster row without a width means the original metadata read
    // failed or predates the pipeline — a regenerate run re-reads the
    // bytes and fills it, so treat every satisfiable-at-any-width tag
    // as potentially missing rather than skipping silently.
    const missing = MEDIA_VARIANT_TAGS.filter((t) => t !== "orig" && !existing.has(t));
    return missing.length > 0
      ? { missing, skipReason: null }
      : { missing: [], skipReason: null };
  }

  const width = args.width;
  const missing = MEDIA_VARIANT_TAGS.filter((tag): tag is Exclude<MediaVariantTag, "orig"> => {
    if (tag === "orig") return false;
    // Same no-upscaling rule as runMediaPipeline: a breakpoint is only
    // expected when the source is at least that wide.
    return width >= MEDIA_VARIANT_WIDTHS[tag] && !existing.has(tag);
  });
  if (missing.length > 0) return { missing, skipReason: null };

  if (width < MEDIA_VARIANT_WIDTHS["webp-400"]) {
    return {
      missing: [],
      skipReason: `source is ${width}px wide — below the smallest WebP breakpoint (400px), so no WebP variant is ever emitted (no upscaling); reference /orig in module HTML`,
    };
  }
  // Every breakpoint the source can satisfy exists (or, for animated
  // GIFs, the regenerate pipeline run itself reports why nothing new
  // was produced — animation is only detectable from the bytes).
  return { missing: [], skipReason: null };
}
