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
  /** Pixel width of the stored file, when known (`media_variants.width`).
   *  Needed for the `orig` entry so an orig embed's srcset can offer the
   *  original at its real width (#667). */
  readonly width?: number | null;
}

/** Original formats the WebP ladder can stand in for. SVG/ICO are not
 *  raster sources and GIFs may be animated (the ladder is a still frame). */
const LADDER_REPLACEABLE_ORIG_FORMATS: ReadonlySet<string> = new Set([
  "png",
  "jpeg",
  "jpg",
  "webp",
  "avif",
]);

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
 * Run #10 D4: `find_media` (and the since-removed `## Media`
 * system-prompt block) advertised `webp-800` for every raster mime, but
 * the pipeline never emits `webp-800` for sources narrower than 800px
 * (no upscaling) or for animated GIFs — the AI wrote those URLs into
 * module HTML and the static generator's media pass failed the whole
 * staging build on
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
   * (ref, variant, format), where `ref` is the asset SLUG (current form)
   * or a legacy UUID id. Return null to leave `src` untouched (the preview
   * keeps its admin-served URLs).
   */
  readonly urlFor: (ref: string, variant: string, format: string) => string;
  /** Rewrite the `src` attribute itself (production) or keep it (preview). */
  readonly rewriteSrc: boolean;
  /** Format lookup per (ref, variant); defaults to webp. */
  readonly formatFor?: (ref: string, variant: string) => string;
}

const ENRICH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Walk every `<img …>` whose src points at `/_caelo/media/<slug>` (or the
 * legacy `/_caelo/media/<uuid>/<variant>`) and append the responsive
 * attributes. `variantsByAsset` is keyed by the same `ref` the caller uses
 * in `urlFor` (slug for current embeds, id for legacy). String-level
 * rewrite; existing attributes always win.
 */
export function enrichResponsiveImages(
  html: string,
  variantsByAsset: ReadonlyMap<string, readonly ImageVariantInfo[]>,
  options: EnrichResponsiveImagesOptions,
): string {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const srcMatch = tag.match(
      /\bsrc=("|')\/_caelo\/media\/([a-z0-9][a-z0-9-]{0,63})(?:\/([a-z][a-z0-9-]{0,63}))?\1/,
    );
    if (!srcMatch) return tag;
    const seg1 = srcMatch[2] as string;
    const seg2 = srcMatch[3];
    // Legacy id form only when a full uuid is followed by an explicit
    // variant; otherwise `ref` is the slug and orig is implied.
    const isLegacyId = ENRICH_UUID_RE.test(seg1) && seg2 !== undefined;
    const ref = seg1;
    const variant = isLegacyId ? (seg2 as string) : (seg2 ?? "orig");
    const assetId = ref;
    const variants = variantsByAsset.get(ref) ?? [];

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
      out = out.replace(
        srcMatch[0],
        () => `src="${options.urlFor(assetId, variant, requestedFormat)}"`,
      );
    }

    // #667 — an `orig` embed (the default `/_caelo/media/<slug>` form,
    // typical for logos) shipped the full original as PNG/JPEG even when
    // the pipeline had a WebP ladder for it: Lighthouse's image-delivery
    // insight flagged the format and the oversize on every such image.
    // Only the author knows the rendered width (a `width` attribute is often
    // just the intrinsic size that CSS stretches), so the ladder is offered
    // only when the tag declares that contract itself with `sizes`: then
    // the WebP ladder plus the original at its real width go into srcset
    // and the browser picks the smallest file that covers the declared
    // size. Without `sizes` the tag keeps shipping the original.
    const origLadder =
      variant === "orig" && /\bsizes=/i.test(out) && !/\bsrcset=/i.test(out)
        ? origSrcset(variants, assetId, options)
        : null;
    if (origLadder) {
      out = out.replace(/<img\b/, () => `<img srcset="${origLadder}"`);
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
        () => `<img srcset="${srcset}" sizes="${/\bsizes=/i.test(out) ? "" : sizes}"`,
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

/**
 * The srcset for an `orig` embed whose author declared `sizes`, or null when
 * it would not help: no raster original, no WebP breakpoint the source could
 * fill, or an original whose width is unknown (without it the browser could
 * be offered only candidates narrower than the image it needs, and upscale
 * them).
 */
function origSrcset(
  variants: readonly ImageVariantInfo[],
  assetId: string,
  options: EnrichResponsiveImagesOptions,
): string | null {
  const orig = variants.find((v) => v.variant === "orig");
  if (!orig || !LADDER_REPLACEABLE_ORIG_FORMATS.has(orig.format)) return null;
  const origWidth = orig.width ?? null;
  if (origWidth === null) return null;
  const ladder = variants
    .filter((v) => variantFamily(v.variant) === "webp" && v.format === "webp")
    .map((v) => ({ variant: v.variant, width: parseVariantWidth(v.variant) }))
    .filter(
      (v): v is { variant: string; width: number } => v.width !== null && v.width <= origWidth,
    )
    .sort((a, b) => a.width - b.width);
  const widest = ladder.at(-1);
  if (!widest) return null;
  const entries = ladder.map((v) => `${options.urlFor(assetId, v.variant, "webp")} ${v.width}w`);
  // The original is only a candidate when it is wider than every WebP
  // (a source wider than the largest breakpoint); otherwise the WebP of
  // the same width replaces it.
  if (origWidth > widest.width) {
    entries.push(`${options.urlFor(assetId, "orig", orig.format)} ${origWidth}w`);
  }
  return entries.join(", ");
}
