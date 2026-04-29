// SPDX-License-Identifier: MPL-2.0

/**
 * Media library — shared primitives.
 *
 * Browser-safe: Zod schemas, MIME allowlist, size caps, the variant
 * convention. Sharp + filesystem adapters live in `@caelo/admin-core`
 * (server-only). The storage-key shape is stable here so the static
 * generator's URL rewriter and the admin's iframe resolver agree on
 * the canonical form `<sha>/<variant>.<ext>`.
 */

import { z } from "zod";

/**
 * Allowlisted MIME types. Anything outside this set is rejected at the
 * upload endpoint with `415 Unsupported Media Type`. SVG is allowed
 * but capped tight to discourage XSS via embedded scripts; the upload
 * pipeline strips `<script>` and event-handler attributes before
 * persisting (see {@link sanitizeSvg} in admin-core).
 */
export const MEDIA_ALLOWED_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
  "video/mp4",
] as const;
export type MediaMime = (typeof MEDIA_ALLOWED_MIMES)[number];

/** Per-MIME size caps (bytes). Server enforces; client display only. */
export const MEDIA_SIZE_CAPS: Record<MediaMime, number> = {
  "image/jpeg": 10 * 1024 * 1024,
  "image/png": 10 * 1024 * 1024,
  "image/webp": 10 * 1024 * 1024,
  "image/avif": 10 * 1024 * 1024,
  "image/gif": 8 * 1024 * 1024,
  "image/svg+xml": 1 * 1024 * 1024,
  "application/pdf": 20 * 1024 * 1024,
  "video/mp4": 50 * 1024 * 1024,
};

/** Hard ceiling on the multipart body. Per-MIME caps narrow further. */
export const MEDIA_HARD_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * Variant tags. `orig` is always present (re-encoded only for SVG
 * sanitisation). Image-only WebP variants are emitted at breakpoints
 * the source can satisfy — a 600px-wide source skips webp-1200 +
 * webp-1600 entirely.
 */
export const MEDIA_VARIANT_TAGS = [
  "orig",
  "webp-1600",
  "webp-1200",
  "webp-800",
  "webp-400",
] as const;
export type MediaVariantTag = (typeof MEDIA_VARIANT_TAGS)[number];

/** Width-in-pixels target for each WebP variant. */
export const MEDIA_VARIANT_WIDTHS: Record<Exclude<MediaVariantTag, "orig">, number> = {
  "webp-1600": 1600,
  "webp-1200": 1200,
  "webp-800": 800,
  "webp-400": 400,
};

/**
 * Renderer-agnostic asset URL used in module HTML. Both the SvelteKit
 * admin endpoint and the static generator's media-pass parse this
 * shape; the static generator rewrites to `/_assets/...` (or a CDN
 * URL) at deploy time.
 *
 * Format: `/_caelo/media/<asset-id>/<variant>`. The asset id, not the
 * sha, so URLs survive a re-upload of the same content under a new id.
 */
export const MEDIA_URL_PREFIX = "/_caelo/media";

export function buildMediaUrl(assetId: string, variant: MediaVariantTag): string {
  return `${MEDIA_URL_PREFIX}/${assetId}/${variant}`;
}

// Variant token: `orig`, `webp-<width>`, or `<crop-name>-<width>`. We
// accept any kebab-case slug so focal-point crop fan-outs like
// `square-800` and `wide-1200` (added by P7 optimization #2) round-trip
// without a regex update per crop name.
const mediaUrlPattern = new RegExp(
  `${MEDIA_URL_PREFIX}/([0-9a-f-]{36})/([a-z][a-z0-9-]{0,63})`,
  "g",
);

/**
 * Extract every (assetId, variant) pair referenced in an HTML string.
 * Used by the post-write usage-tracker and by the static-generator
 * media-pass. Returns a deduped list to keep callers' work proportional
 * to unique assets, not raw match count.
 */
export function extractMediaRefs(html: string): { assetId: string; variant: string }[] {
  const seen = new Set<string>();
  const out: { assetId: string; variant: string }[] = [];
  for (const m of html.matchAll(mediaUrlPattern)) {
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ assetId: m[1] as string, variant: m[2] as string });
  }
  return out;
}

// ---------------------------------------------------------------------
// Zod schemas — exposed at the Query-API boundary.
// ---------------------------------------------------------------------

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be hex sha256");

export const mediaUploadInputSchema = z
  .object({
    sha256: sha256Schema,
    originalName: z.string().min(1).max(512),
    mime: z.enum(MEDIA_ALLOWED_MIMES),
    sizeBytes: z.number().int().positive(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    alt: z.string().max(2048).default(""),
    storageKey: z.string().min(1),
    /** P7 optimization #3 — stamped by the upload endpoint via getMediaStorageProvider(). */
    storageProvider: z.string().min(1).max(64).default("local"),
    variants: z
      .array(
        z.object({
          variant: z.string().min(1).max(64),
          format: z.string().min(1).max(32),
          width: z.number().int().positive().nullable(),
          height: z.number().int().positive().nullable(),
          sizeBytes: z.number().int().positive(),
          storageKey: z.string().min(1),
        }),
      )
      .min(1),
  })
  .strict();
export type MediaUploadInput = z.infer<typeof mediaUploadInputSchema>;

export const mediaListInputSchema = z
  .object({
    query: z.string().max(256).optional(),
    mime: z.enum(MEDIA_ALLOWED_MIMES).optional(),
    sort: z.enum(["recent", "most_used"]).default("recent"),
    limit: z.number().int().positive().max(200).default(60),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
export type MediaListInput = z.infer<typeof mediaListInputSchema>;

export const mediaUpdateAltInputSchema = z
  .object({
    assetId: z.string().uuid(),
    alt: z.string().max(2048),
  })
  .strict();
export type MediaUpdateAltInput = z.infer<typeof mediaUpdateAltInputSchema>;

export const mediaDeleteInputSchema = z
  .object({
    assetId: z.string().uuid(),
    force: z.boolean().default(false),
  })
  .strict();

export const mediaRecordUsageInputSchema = z
  .object({
    /** Map of assetId → net delta (positive when added, negative when removed). */
    deltas: z.record(z.string().uuid(), z.number().int()),
  })
  .strict();
export type MediaRecordUsageInput = z.infer<typeof mediaRecordUsageInputSchema>;

export const mediaRecentForAiInputSchema = z
  .object({
    limit: z.number().int().positive().max(60).default(30),
  })
  .strict();

export const mediaSetCdnInputSchema = z
  .object({
    enabled: z.boolean(),
    threshold: z.number().int().min(1).max(10000),
  })
  .strict();
export type MediaSetCdnInput = z.infer<typeof mediaSetCdnInputSchema>;

// ---------------------------------------------------------------------
// Storage adapter interface — implemented by LocalVolumeAdapter in
// admin-core, by per-cloud adapters in P15.
// ---------------------------------------------------------------------

/**
 * Object-storage abstraction. The DB never holds blob bytes — only
 * metadata + the storage key. Adapters are responsible for the full
 * key→bytes round-trip; the URL form they expose is renderer-agnostic
 * (LocalVolumeAdapter returns `/_caelo/media/<assetId>/<variant>` so
 * the SvelteKit endpoint can resolve; cloud adapters can return CDN
 * URLs directly).
 */
export interface MediaStorageAdapter {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Bytes-on-disk for capacity reporting. */
  totalSizeBytes(): Promise<number>;
}

/** Build the canonical storage key for a given asset variant. */
export function buildStorageKey(sha256: string, variant: MediaVariantTag, ext: string): string {
  return `${sha256}/${variant}.${ext}`;
}
