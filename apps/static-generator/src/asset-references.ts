// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the files a build references instead of containing them.
 *
 * Media and fonts are content-addressed (`_assets/<slug>.<hash>.<ext>`,
 * #667) and already stored: media in the media store (`MEDIA_ROOT_DIR`,
 * the gcsfuse mount of the media bucket on GCP), fonts in the fonts cache.
 * Copying their bytes into every build put all of a site's images into the
 * container's `/tmp` (memory on Cloud Run) and through the publisher's
 * heap, on every Stage — the OOM of 2026-10-30.
 *
 * So the build lists them here, path → stored digests, and the publisher
 * of each provider delivers them:
 *   - Firebase: `populateFiles` with the stored gzip hash; only files Hosting
 *     lacks are streamed from the store.
 *   - GCS: a path the live bucket already has (the name carries the content
 *     hash) is skipped; the rest is streamed from the store.
 *   - self-hosted: the generator hard-links them into the build (a link
 *     reads no byte; a copy across filesystems is done by the kernel).
 *
 * Only what the build references is listed, so staging and live serve
 * exactly the media their pages use — an unpublished or private asset
 * never reaches a provider this way.
 *
 * The file sits in the build directory but is not part of the site: every
 * publisher leaves it out of what it serves ({@link BUILD_INTERNAL_FILES}).
 */

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

/** Where a build lists its referenced files (build-relative). */
export const ASSET_REFERENCES_FILE = "_caelo-asset-references.json";

/** Where a build's parity digests are written (parity-digest.ts). */
export const PARITY_FILE = "_caelo-parity.json";

/** Build files that describe the build for the deploy ops and are never served. */
export const BUILD_INTERNAL_FILES: ReadonlySet<string> = new Set([
  ASSET_REFERENCES_FILE,
  PARITY_FILE,
]);

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const assetReferenceSchema = z
  .object({
    /** Build-relative public path (`_assets/…`), as the pages link it. */
    path: z.string().min(1),
    contentSha256: hex64,
    size: z.number().int().nonnegative(),
    gzipSha256: hex64,
    gzipSize: z.number().int().nonnegative(),
    /** See published-digest.ts: which gzip the gzip digests belong to. */
    digestProfile: z.string().min(1),
    /** Where the bytes are: a media storage key, or a path in the fonts cache. */
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("media"), storageKey: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("font"), relPath: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

/** One file the build references (see the file header). */
export type AssetReference = z.infer<typeof assetReferenceSchema>;

const assetReferencesFileSchema = z
  .object({
    version: z.literal(1),
    /** Absolute media store root the generator resolved (`MEDIA_ROOT_DIR`). */
    mediaRoot: z.string().min(1),
    /** Absolute fonts cache directory the generator resolved. */
    fontsCacheDir: z.string().min(1),
    assets: z.array(assetReferenceSchema),
  })
  .strict();

/** The parsed {@link ASSET_REFERENCES_FILE}. */
export type AssetReferences = z.infer<typeof assetReferencesFileSchema>;

/** Serialise the references for {@link ASSET_REFERENCES_FILE}. */
export function serializeAssetReferences(refs: AssetReferences): string {
  return JSON.stringify(assetReferencesFileSchema.parse(refs));
}

/**
 * Read a build's references. A build without the file is not one this
 * generator produced (every build writes it, empty or not): fail loudly
 * instead of publishing a site whose media would 404.
 */
export async function readAssetReferences(buildDir: string): Promise<AssetReferences> {
  let raw: string;
  try {
    raw = await readFile(join(buildDir, ASSET_REFERENCES_FILE), "utf8");
  } catch (e) {
    throw new Error(
      `${join(buildDir, ASSET_REFERENCES_FILE)} is missing (${(e as Error).message}). The static generator writes it on every build; re-run the build instead of publishing a partial directory.`,
    );
  }
  return assetReferencesFileSchema.parse(JSON.parse(raw));
}

/** Absolute path of a referenced file's bytes, refusing anything outside its store. */
export function assetSourcePath(refs: AssetReferences, asset: AssetReference): string {
  const [root, rel] =
    asset.source.kind === "media"
      ? [refs.mediaRoot, asset.source.storageKey]
      : [refs.fontsCacheDir, asset.source.relPath];
  const base = resolve(root);
  const file = resolve(base, rel);
  if (!file.startsWith(`${base}${sep}`)) {
    throw new Error(`asset ${asset.path}: source "${rel}" escapes its store ${base}`);
  }
  return file;
}
