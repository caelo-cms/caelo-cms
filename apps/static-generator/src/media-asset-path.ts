// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #667 — content-addressed public paths for published media.
 *
 * Media used to ship under its stable slug (`_assets/<slug>.<ext>`). The
 * operator can replace the bytes behind a slug, so those URLs could never
 * be cached for long: every provider served them with a 1-hour lifetime
 * and Lighthouse's cache insight flagged every logo, image and imported
 * font on every site. A content hash in the file name makes the URL change
 * whenever the bytes do, so the file can be cached forever
 * (`CONTENT_HASHED_PATH_PATTERN` in `@caelo-cms/shared`) and a replaced
 * image still shows up with the next publish (the pages are short-lived
 * and point at the new name).
 *
 * The name keeps the readable slug in front of the hash:
 *   - slug ref, orig variant  → `_assets/<slug>.<hash>.<ext>`
 *   - slug ref, named variant → `_assets/<slug>/<variant>.<hash>.<ext>`
 *   - legacy id ref           → `_assets/<id>/<variant>.<hash>.<ext>`
 *
 * The hash is taken from the bytes that are actually published (not from
 * the storage key), so an immutable URL never outlives the bytes it named.
 * #1271 — from the file's stored sha256 (`media_variants.content_sha256`,
 * taken when the file was written), so naming a file reads none of it.
 */

import { MEDIA_CONTENT_HASH_HEX_LENGTH } from "@caelo-cms/shared";

/** File extension for a stored media format (`jpeg` publishes as `.jpg`). */
export function formatToExt(format: string): string {
  if (format === "jpeg") return "jpg";
  return format;
}

/**
 * The content hash used in published media names (hex, fixed length), from
 * the file's stored sha256 (hex).
 */
export function mediaContentHash(contentSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new Error(`static-generator: not a sha256 digest: ${contentSha256}`);
  }
  return contentSha256.slice(0, MEDIA_CONTENT_HASH_HEX_LENGTH);
}

/**
 * Build-relative path (no leading slash) of one published media file.
 * The public URL is this string with a leading `/`.
 */
export function mediaAssetRelPath(args: {
  readonly ref: string;
  readonly isSlug: boolean;
  readonly variant: string;
  readonly format: string;
  readonly contentHash: string;
}): string {
  const ext = formatToExt(args.format);
  if (args.isSlug && args.variant === "orig") {
    return `_assets/${args.ref}.${args.contentHash}.${ext}`;
  }
  return `_assets/${args.ref}/${args.variant}.${args.contentHash}.${ext}`;
}
