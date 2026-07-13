// SPDX-License-Identifier: MPL-2.0

/**
 * issue #162 — responsive-image markup, ONE implementation for both
 * render surfaces. Production (the static generator's media pass) and
 * the editor preview must emit the same `srcset`/`sizes`/`loading`/
 * `decoding` shape — the operator tunes visuals against the preview,
 * and the #155 self-review loop makes design decisions from preview
 * screenshots, so markup drift there means optimizing the wrong
 * artifact. Only the URL form differs (parameterized `urlFor`):
 * `/_assets/<id>/<variant>.<ext>` in builds, `/_caelo/media/<id>/<variant>`
 * in the admin preview.
 *
 * Extracted from apps/static-generator/src/media-pass.ts verbatim in
 * behaviour: author-supplied srcset/sizes/loading/decoding always keep
 * precedence; ladders under two entries add no srcset.
 */

export interface ImageVariantInfo {
  readonly variant: string;
  readonly format: string;
}

/** Extract `webp-800` → 800; `square-400` → 400; `orig` → null. */
export function parseVariantWidth(variant: string): number | null {
  const m = variant.match(/-(\d+)$/);
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

/** `webp-800` → 'webp'; `square-800` → 'square'; `orig` → 'orig'. */
export function variantFamily(variant: string): string {
  const m = variant.match(/^([a-z][a-z0-9-]*?)-\d+$/);
  return m?.[1] ? m[1] : variant;
}

/**
 * Pick the variant tag AI-facing surfaces should hand out for an
 * asset, given the variant tags that ACTUALLY exist on it.
 *
 * Run #10 D4: `find_media` and the `## Media` system-prompt block
 * advertised `webp-800` for every raster mime, but the pipeline never
 * emits `webp-800` for sources narrower than 800px (no upscaling) or
 * for animated GIFs — the AI wrote those URLs into module HTML and the
 * static generator's media pass failed the whole staging build on
 * "asset/variant pairs missing". Advertising must be grounded in the
 * `media_variants` rows, not in the mime.
 *
 * Preference order: `webp-800` when present; else the LARGEST webp at
 * or below 800 (best quality that exists without shipping a hero-sized
 * file); else the smallest webp above 800; else `orig` (always exists).
 *
 * @param existingVariants variant tags present in `media_variants` for the asset.
 */
export function pickAiImageVariant(existingVariants: readonly string[]): string {
  const webps = existingVariants
    .map((v) => ({ variant: v, width: parseVariantWidth(v) }))
    .filter(
      (v): v is { variant: string; width: number } =>
        variantFamily(v.variant) === "webp" && v.width !== null,
    );
  const exact = webps.find((v) => v.width === 800);
  if (exact) return exact.variant;
  const below = webps.filter((v) => v.width < 800).sort((a, b) => b.width - a.width)[0];
  if (below) return below.variant;
  const above = webps.filter((v) => v.width > 800).sort((a, b) => a.width - b.width)[0];
  if (above) return above.variant;
  return "orig";
}

export interface EnrichResponsiveImagesOptions {
  /**
   * Build the URL an enriched attribute should reference for
   * (assetId, variant, format). Return null to leave `src` untouched
   * (the preview keeps its admin-served URLs).
   */
  readonly urlFor: (assetId: string, variant: string, format: string) => string;
  /** Rewrite the `src` attribute itself (production) or keep it (preview). */
  readonly rewriteSrc: boolean;
  /** Format lookup per (assetId, variant); defaults to webp. */
  readonly formatFor?: (assetId: string, variant: string) => string;
}

/**
 * Walk every `<img …>` whose src points at `/_caelo/media/<id>/<variant>`
 * and append the responsive attributes. String-level rewrite; existing
 * attributes always win.
 */
export function enrichResponsiveImages(
  html: string,
  variantsByAsset: ReadonlyMap<string, readonly ImageVariantInfo[]>,
  options: EnrichResponsiveImagesOptions,
): string {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const srcMatch = tag.match(
      /\bsrc=("|')\/_caelo\/media\/([0-9a-f-]{36})\/([a-z][a-z0-9-]{0,63})\1/,
    );
    if (!srcMatch) return tag;
    const assetId = srcMatch[2] as string;
    const variant = srcMatch[3] as string;
    const variants = variantsByAsset.get(assetId) ?? [];

    const family = variantFamily(variant);
    const familyVariants = variants
      .filter((v) => variantFamily(v.variant) === family && v.format === "webp")
      .map((v) => ({ variant: v.variant, width: parseVariantWidth(v.variant) }))
      .filter((v): v is { variant: string; width: number } => v.width !== null)
      .sort((a, b) => a.width - b.width);

    const requestedWidth = parseVariantWidth(variant);
    const requestedFormat = options.formatFor?.(assetId, variant) ?? "webp";

    let out = tag;
    if (options.rewriteSrc) {
      out = out.replace(srcMatch[0], `src="${options.urlFor(assetId, variant, requestedFormat)}"`);
    }

    if (familyVariants.length >= 2 && !/\bsrcset=/i.test(out)) {
      const srcset = familyVariants
        .map((v) => `${options.urlFor(assetId, v.variant, "webp")} ${v.width}w`)
        .join(", ");
      const sizes =
        requestedWidth !== null
          ? `(max-width: 600px) 400px, (max-width: 1200px) 800px, ${requestedWidth}px`
          : "100vw";
      out = out.replace(
        /<img\b/,
        `<img srcset="${srcset}" sizes="${/\bsizes=/i.test(out) ? "" : sizes}"`,
      );
      out = out.replace(/\bsizes=""\s*/g, "");
    }

    if (!/\bloading=/i.test(out)) {
      out = out.replace(/<img\b/, '<img loading="lazy"');
    }
    if (!/\bdecoding=/i.test(out)) {
      out = out.replace(/<img\b/, '<img decoding="async"');
    }
    return out;
  });
}
