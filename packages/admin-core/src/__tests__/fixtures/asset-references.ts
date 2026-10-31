// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — every build lists the media and fonts it references in
 * `_caelo-asset-references.json`; publisher tests that hand-write a build
 * directory write it too.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ASSET_REFERENCES_FILE,
  type AssetReference,
  digestBytes,
} from "@caelo-cms/static-generator";

/** Write the references file of a hand-made build (no references by default). */
export async function writeAssetReferences(
  buildDir: string,
  args: { mediaRoot?: string; fontsCacheDir?: string; assets?: readonly AssetReference[] } = {},
): Promise<void> {
  await writeFile(
    join(buildDir, ASSET_REFERENCES_FILE),
    JSON.stringify({
      version: 1,
      mediaRoot: args.mediaRoot ?? join(buildDir, "..", "media"),
      fontsCacheDir: args.fontsCacheDir ?? join(buildDir, "..", "fonts"),
      assets: args.assets ?? [],
    }),
    "utf8",
  );
}

/**
 * Store `bytes` under `storageKey` in `mediaRoot` and return the reference a
 * build would list for it at `path`.
 */
export async function storedMediaReference(args: {
  mediaRoot: string;
  storageKey: string;
  path: string;
  bytes: Uint8Array;
}): Promise<AssetReference> {
  const file = join(args.mediaRoot, args.storageKey);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, args.bytes);
  const d = await digestBytes(args.bytes);
  return {
    path: args.path,
    contentSha256: d.contentSha256,
    size: d.size,
    gzipSha256: d.gzipSha256,
    gzipSize: d.gzipSize,
    digestProfile: d.profile,
    source: { kind: "media", storageKey: args.storageKey },
  };
}
