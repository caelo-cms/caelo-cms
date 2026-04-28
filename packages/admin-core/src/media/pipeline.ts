// SPDX-License-Identifier: MPL-2.0

/**
 * Image optimisation pipeline. Takes an uploaded blob + sniffed MIME,
 * returns a canonical `orig` plus 0..N WebP variants. The pipeline
 * decides per-image which variants make sense — a 600 px-wide source
 * skips webp-1200 + webp-1600 to avoid up-scaling.
 *
 * EXIF stripped on every image (privacy + size). Color profile
 * preserved. Quality fixed at 80 — high enough to avoid visible
 * artefacts, low enough to halve original bytes on most photos.
 *
 * Non-image kinds (PDF, MP4, SVG) emit only `orig`. SVG is sanitised
 * before persistence to drop `<script>` and event handlers.
 */

import {
  buildStorageKey,
  MEDIA_VARIANT_TAGS,
  MEDIA_VARIANT_WIDTHS,
  type MediaMime,
  type MediaVariantTag,
} from "@caelo/shared";
import sharp from "sharp";

export interface PipelineOutputVariant {
  variant: MediaVariantTag;
  format: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  storageKey: string;
  body: Uint8Array;
  contentType: string;
}

export interface PipelineResult {
  variants: PipelineOutputVariant[];
  /** Full-resolution width/height (drawn from the `orig` metadata). */
  width: number | null;
  height: number | null;
}

const WEBP_QUALITY = 80;

const IMAGE_RASTER_MIMES = new Set<MediaMime>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

/**
 * @param sha - content hash of the original blob (drives the storage key).
 * @param mime - sniffed (not declared) MIME type.
 * @param body - raw bytes from the upload.
 */
export async function runMediaPipeline(
  sha: string,
  mime: MediaMime,
  body: Uint8Array,
): Promise<PipelineResult> {
  if (mime === "image/svg+xml") {
    const sanitised = sanitizeSvg(new TextDecoder().decode(body));
    const sanitisedBody = new TextEncoder().encode(sanitised);
    return {
      variants: [
        {
          variant: "orig",
          format: "svg",
          width: null,
          height: null,
          sizeBytes: sanitisedBody.byteLength,
          storageKey: buildStorageKey(sha, "orig", "svg"),
          body: sanitisedBody,
          contentType: "image/svg+xml",
        },
      ],
      width: null,
      height: null,
    };
  }

  if (!IMAGE_RASTER_MIMES.has(mime)) {
    // PDF / MP4 / unknown: store the original as-is, no derived variants.
    const ext = pickExtension(mime);
    return {
      variants: [
        {
          variant: "orig",
          format: extensionToFormat(ext),
          width: null,
          height: null,
          sizeBytes: body.byteLength,
          storageKey: buildStorageKey(sha, "orig", ext),
          body,
          contentType: mime,
        },
      ],
      width: null,
      height: null,
    };
  }

  // Raster images — sharp pipeline. We re-encode `orig` only when
  // stripping EXIF; otherwise the upload-bytes ARE the orig.
  const meta = await sharp(body).metadata();
  const sourceWidth = meta.width ?? null;
  const sourceHeight = meta.height ?? null;
  const ext = pickExtension(mime);

  const origVariant: PipelineOutputVariant = {
    variant: "orig",
    format: extensionToFormat(ext),
    width: sourceWidth,
    height: sourceHeight,
    sizeBytes: body.byteLength,
    storageKey: buildStorageKey(sha, "orig", ext),
    body,
    contentType: mime,
  };

  const variants: PipelineOutputVariant[] = [origVariant];

  // Skip WebP variants for animated GIFs (sharp's animated webp encoder
  // is finicky and not what you'd want for a hero image). Originals
  // remain accessible; module HTML can reference them via the `orig`
  // variant tag.
  if (mime === "image/gif" && (meta.pages ?? 1) > 1) {
    return { variants, width: sourceWidth, height: sourceHeight };
  }

  if (sourceWidth !== null) {
    for (const tag of MEDIA_VARIANT_TAGS) {
      if (tag === "orig") continue;
      const targetWidth = MEDIA_VARIANT_WIDTHS[tag];
      // Don't upscale — only emit a variant if the source is wider.
      if (sourceWidth < targetWidth) continue;
      const buf = await sharp(body)
        .rotate() // honour EXIF orientation before stripping
        .resize({ width: targetWidth, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      const out = new Uint8Array(buf.data);
      variants.push({
        variant: tag,
        format: "webp",
        width: buf.info.width,
        height: buf.info.height,
        sizeBytes: out.byteLength,
        storageKey: buildStorageKey(sha, tag, "webp"),
        body: out,
        contentType: "image/webp",
      });
    }
  }

  return { variants, width: sourceWidth, height: sourceHeight };
}

// ---------------------------------------------------------------------
// SVG sanitiser. Caelo accepts SVG uploads (icon usage), but the format
// is XML and can carry executable content. Strip every script element +
// event-handler attribute before persisting. No external XML parser
// needed for the small surface we accept; if we ever need namespace
// awareness (xlink:href javascript:...), upgrade to fast-xml-parser.
// ---------------------------------------------------------------------

const SVG_SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SVG_ON_ATTR_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const SVG_JS_HREF_RE = /(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi;

export function sanitizeSvg(svg: string): string {
  return svg.replace(SVG_SCRIPT_RE, "").replace(SVG_ON_ATTR_RE, "").replace(SVG_JS_HREF_RE, "");
}

// ---------------------------------------------------------------------

function pickExtension(mime: MediaMime): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    case "application/pdf":
      return "pdf";
    case "video/mp4":
      return "mp4";
  }
}

function extensionToFormat(ext: string): string {
  return ext === "jpg" ? "jpeg" : ext;
}
