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
 * the storage key): `regenerate_media_variants` rewrites a variant in
 * place under the same key, and an immutable URL must never outlive the
 * bytes it named.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MEDIA_CONTENT_HASH_HEX_LENGTH } from "@caelo-cms/shared";

/** File extension for a stored media format (`jpeg` publishes as `.jpg`). */
export function formatToExt(format: string): string {
  if (format === "jpeg") return "jpg";
  return format;
}

/** The content hash used in published media names (hex, fixed length). */
export function mediaContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, MEDIA_CONTENT_HASH_HEX_LENGTH);
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

/**
 * Read a stored media file. Returns null when the file is missing (the
 * caller collects those into one AI-actionable error); any other read
 * failure throws. The storage key is server-controlled (sha-prefixed),
 * but a key escaping `mediaRoot` is refused anyway.
 */
export async function readStoredMedia(
  mediaRoot: string,
  storageKey: string,
): Promise<Uint8Array | null> {
  const root = resolve(mediaRoot);
  const source = resolve(join(root, storageKey));
  if (!source.startsWith(`${root}/`) && source !== root) {
    throw new Error(`static-generator: storage key escapes mediaRoot: ${storageKey}`);
  }
  try {
    return await readFile(source);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Write `bytes` into the build at its content-addressed path; returns that path. */
export async function writePublishedMedia(args: {
  readonly buildDir: string;
  readonly ref: string;
  readonly isSlug: boolean;
  readonly variant: string;
  readonly format: string;
  readonly bytes: Uint8Array;
}): Promise<string> {
  const relPath = mediaAssetRelPath({ ...args, contentHash: mediaContentHash(args.bytes) });
  const outPath = join(args.buildDir, relPath);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, args.bytes);
  return relPath;
}
