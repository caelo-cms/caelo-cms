// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the theme's font files as build references, keyed by their
 * content hash (asset-references.ts), instead of byte copies in every build.
 *
 * The fonts cache is content-addressed and never rewritten in place
 * (fonts-resolver.ts), so a file's digests are taken once and kept next to
 * it (`<file>.digest.json`); a later build reads that small record, not the
 * font. A record from another gzip profile, or one whose size no longer
 * matches the file (a license text written again), is taken again.
 */

import { copyFile, link, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AssetReference } from "./asset-references.js";
import type { MediaDelivery } from "./media-pass.js";
import { digestFile, digestProfile, type PublishedDigest } from "./published-digest.js";

/** Where the theme's fonts are published in every build. */
export const FONTS_PUBLIC_DIR = "_assets/fonts";

const digestRecord = z
  .object({
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    gzipSha256: z.string().regex(/^[0-9a-f]{64}$/),
    gzipSize: z.number().int().nonnegative(),
    profile: z.string().min(1),
  })
  .strict();

/** The digests of a cached font file, from its record or taken now. */
async function cachedFontDigest(cachePath: string): Promise<PublishedDigest> {
  const recordPath = `${cachePath}.digest.json`;
  const profile = await digestProfile();
  try {
    const parsed = digestRecord.safeParse(JSON.parse(await readFile(recordPath, "utf8")));
    if (
      parsed.success &&
      parsed.data.profile === profile &&
      parsed.data.size === (await stat(cachePath)).size
    ) {
      return parsed.data;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  const digest = await digestFile(cachePath);
  await writeFile(recordPath, JSON.stringify(digest), "utf8");
  return digest;
}

/**
 * The build references of the resolved font files. With `link` delivery
 * (self-hosted) each is also hard-linked into the build at its public path.
 */
export async function publishFontFiles(args: {
  readonly files: readonly { readonly cachePath: string; readonly relPath: string }[];
  readonly fontsCacheDir: string;
  readonly buildDir: string;
  readonly delivery: MediaDelivery;
}): Promise<AssetReference[]> {
  const out: AssetReference[] = [];
  for (const f of args.files) {
    if (!f.cachePath.startsWith(`${args.fontsCacheDir}/`)) {
      throw new Error(
        `static-generator: font file ${f.cachePath} is outside the fonts cache ${args.fontsCacheDir}`,
      );
    }
    const digest = await cachedFontDigest(f.cachePath);
    const path = `${FONTS_PUBLIC_DIR}/${f.relPath}`;
    if (args.delivery === "link") {
      const target = join(args.buildDir, path);
      await mkdir(dirname(target), { recursive: true });
      try {
        await link(f.cachePath, target);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EXDEV" || code === "EPERM") await copyFile(f.cachePath, target);
        else if (code !== "EEXIST") throw e;
      }
    }
    out.push({
      path,
      contentSha256: digest.contentSha256,
      size: digest.size,
      gzipSha256: digest.gzipSha256,
      gzipSize: digest.gzipSize,
      digestProfile: digest.profile,
      source: { kind: "font", relPath: f.cachePath.slice(args.fontsCacheDir.length + 1) },
    });
  }
  return out;
}
