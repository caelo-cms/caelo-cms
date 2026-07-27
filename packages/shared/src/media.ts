// SPDX-License-Identifier: MPL-2.0

/**
 * Media library — shared primitives.
 *
 * Browser-safe: Zod schemas, MIME allowlist, size caps, the variant
 * convention. Sharp + filesystem adapters live in `@caelo-cms/admin-core`
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
  // issue #249 — webfonts. Migrated sites reference their own font
  // files from replayed CSS; the media-migration pass downloads them
  // into the library so the rebuilt site survives the source host
  // going away. Stored as-is (no derived variants).
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
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
  "font/woff2": 5 * 1024 * 1024,
  "font/woff": 5 * 1024 * 1024,
  "font/ttf": 5 * 1024 * 1024,
  "font/otf": 5 * 1024 * 1024,
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
 * Format (current): `/_caelo/media/<slug>` for the orig variant,
 * `/_caelo/media/<slug>/<variant>` for a named variant (webp/crops). The
 * `<slug>` is `media_assets.slug` — a human-meaningful name (e.g.
 * `searchviu-logo`); the UUID id stays internal. The static generator
 * rewrites these to `/_assets/<slug>.<ext>` (orig) / `/_assets/<slug>/<variant>.<ext>`.
 *
 * Legacy form `/_caelo/media/<uuid>/<variant>` is still PARSED (existing
 * persisted embeds keep resolving), but never newly EMITTED.
 */
export const MEDIA_URL_PREFIX = "/_caelo/media";

/** Full-uuid shape — used to tell a legacy id ref from a slug ref. */
const MEDIA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Build the media URL for an asset SLUG + variant. The orig variant is
 * flat (`/_caelo/media/<slug>`) so a plain image reads as a name, not a
 * path; named variants (srcset webp / focal crops) nest under the slug.
 * Widened to `| string` (run #10 D4): pickAiImageVariant returns whichever
 * variant tag actually exists.
 */
export function buildMediaUrl(slug: string, variant: MediaVariantTag | string): string {
  return variant === "orig"
    ? `${MEDIA_URL_PREFIX}/${slug}`
    : `${MEDIA_URL_PREFIX}/${slug}/${variant}`;
}

/**
 * Turn a human/asset label into a URL-safe media slug: lowercase ascii,
 * kebab-case, extension + junk stripped, capped at 60 chars. NOT
 * uniquified — the caller resolves collisions against the live library
 * (append `-2`/`-3`…); see `resolveUniqueMediaSlug` in admin-core.
 */
export function slugifyMediaName(name: string): string {
  const noExt = name.replace(/\.[a-z0-9]{1,8}$/i, "");
  const slug = noExt
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "image";
}

// Segment token: a slug or uuid (`[a-z0-9-]`) optionally followed by a
// variant. `orig`, `webp-<width>`, `<crop-name>-<width>` all round-trip
// without a per-crop regex update.
const mediaUrlPattern = new RegExp(
  `${MEDIA_URL_PREFIX}/([a-z0-9][a-z0-9-]{0,63})(?:/([a-z][a-z0-9-]{0,63}))?`,
  "g",
);

/**
 * One media reference parsed from HTML. `ref` is either an asset SLUG
 * (`isSlug: true`) or a legacy UUID id (`isSlug: false`); callers resolve
 * a slug ref to an asset id before touching the DB. `variant` defaults to
 * `orig` for the flat slug form.
 */
export interface MediaRef {
  readonly ref: string;
  readonly isSlug: boolean;
  readonly variant: string;
}

/**
 * Extract every media reference in an HTML string (deduped). Used by the
 * post-write usage-tracker and the static-generator media-pass. Handles
 * both the current slug form and the legacy `<uuid>/<variant>` form.
 */
export function extractMediaRefs(html: string): MediaRef[] {
  const seen = new Set<string>();
  const out: MediaRef[] = [];
  for (const m of html.matchAll(mediaUrlPattern)) {
    const seg1 = m[1] as string;
    const seg2 = m[2];
    // A full-uuid first segment with a trailing variant is the legacy id
    // form; everything else is a slug (orig when no explicit variant).
    const isLegacyId = MEDIA_UUID_RE.test(seg1) && seg2 !== undefined;
    const ref = seg1;
    const isSlug = !isLegacyId;
    const variant = seg2 ?? "orig";
    const key = `${isSlug ? "s" : "i"}:${ref}/${variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref, isSlug, variant });
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
    /**
     * Meaningful, human-facing label for the asset (e.g. "SearchVIU logo").
     * The handler slugifies + uniquifies it into `media_assets.slug`, which
     * becomes the public URL (`/_assets/<slug>.<ext>`); the id stays internal.
     * Optional: falls back to `alt` → `originalName` → "image".
     */
    name: z.string().max(200).optional(),
    mime: z.enum(MEDIA_ALLOWED_MIMES),
    sizeBytes: z.number().int().positive(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    alt: z.string().max(2048).default(""),
    storageKey: z.string().min(1),
    /** P7 optimization #3 — stamped by the upload endpoint via getMediaStorageProvider(). */
    storageProvider: z.string().min(1).max(64).default("local"),
    /**
     * Media provenance (0181). Where the asset came from + its licence
     * when known. All optional — a plain human upload may leave them
     * unset. `sourceDetail` is the origin: source URL for imported /
     * external, "<provider>/<model>" for ai_generated, filename/NULL for
     * a plain upload.
     */
    sourceKind: z.enum(["upload", "ai_generated", "imported", "external"]).optional(),
    sourceDetail: z.string().max(2048).optional(),
    license: z.string().max(200).optional(),
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

/**
 * media.set_source (0181) — record/patch an asset's provenance after it
 * exists. COALESCE semantics at the handler: omitted fields stay
 * unchanged, so this both sets provenance the first time and patches a
 * single field (e.g. a licence the operator states later).
 */
export const mediaSetSourceInputSchema = z
  .object({
    assetId: z.string().uuid(),
    sourceKind: z.enum(["upload", "ai_generated", "imported", "external"]).optional(),
    sourceDetail: z.string().max(2048).optional(),
    license: z.string().max(200).optional(),
  })
  .strict();
export type MediaSetSourceInput = z.infer<typeof mediaSetSourceInputSchema>;

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

/**
 * Object-store prefix for images the AI produced during a chat (screenshots
 * of a page, of an external site, of a crawled source page).
 *
 * They are NOT media assets. The operator's library is their own curated
 * space; filling it with machine screenshots would make it useless, and these
 * images have no life outside the conversation that produced them. They live
 * under their own prefix instead, and a scheduled sweep removes the ones whose
 * conversations have aged out (see `chat_images.gc`).
 *
 * The key is `chat-images/<UTC day>/<sha256>.<ext>`:
 *   - the day segment makes age the first thing you can see in a key, so a
 *     sweep never has to open a file to decide;
 *   - the content hash means re-shooting an unchanged page writes the SAME
 *     key. That is not just a storage saving — an identical key keeps the
 *     message history byte-identical, so the provider's prompt cache survives
 *     a re-screenshot of something that did not change.
 */
export const CHAT_IMAGE_PREFIX = "chat-images";

/** Build the storage key for a chat image. `day` is `YYYY-MM-DD` (UTC). */
export function buildChatImageKey(day: string, sha256: string, ext: string): string {
  return `${CHAT_IMAGE_PREFIX}/${day}/${sha256}.${ext}`;
}

/** True for keys under the chat-image prefix — the sweep's safety check. */
export function isChatImageKey(key: string): boolean {
  return key.startsWith(`${CHAT_IMAGE_PREFIX}/`);
}

/** Build the canonical storage key for a given asset variant. */
export function buildStorageKey(
  sha256: string,
  variant: MediaVariantTag | string,
  ext: string,
): string {
  return `${sha256}/${variant}.${ext}`;
}
