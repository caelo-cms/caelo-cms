// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the files of a build as every publisher serves them: what the
 * generator wrote into the build directory (pages, CSS/JS bundles, sitemap,
 * manifests — no media, no fonts), minus the files that only describe the
 * build ({@link BUILD_INTERNAL_FILES}), plus the media and fonts the build
 * references (`_caelo-asset-references.json`), which stay in their stores.
 */

import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
  type AssetReference,
  type AssetReferences,
  BUILD_INTERNAL_FILES,
  readAssetReferences,
} from "@caelo-cms/static-generator";
import { walkFiles } from "./walk-files.js";

/** A file the generator wrote into the build directory. */
export interface BuiltFile {
  readonly absolutePath: string;
  /** Build-relative, `/`-separated, no leading slash — the served path. */
  readonly relativePath: string;
}

/** Everything a build serves: its own files and the ones it references. */
export interface BuildFiles {
  readonly built: readonly BuiltFile[];
  readonly references: AssetReferences;
  /** Every served path (built and referenced). */
  readonly paths: ReadonlySet<string>;
}

/**
 * Files hashed / gzipped at once. Gzip runs on the runtime's worker
 * threads, so this keeps every core busy; the bodies in flight are what
 * the step holds in memory (a few page-sized buffers each).
 */
export const CPU_PARALLELISM = Math.max(4, availableParallelism() * 2);

/**
 * Read a build directory as {@link BuildFiles}. Throws when a referenced
 * path is also a file of the build (two sources for one URL).
 */
export async function readBuildFiles(buildDir: string): Promise<BuildFiles> {
  const built = (await walkFiles(buildDir))
    .filter((rel) => !BUILD_INTERNAL_FILES.has(rel))
    .map((relativePath) => ({ absolutePath: join(buildDir, relativePath), relativePath }));
  const references = await readAssetReferences(buildDir);
  const paths = new Set(built.map((f) => f.relativePath));
  for (const asset of references.assets) {
    if (paths.has(asset.path)) {
      throw new Error(
        `build ${buildDir}: ${asset.path} is both a file of the build and a referenced asset. Re-run the build.`,
      );
    }
    paths.add(asset.path);
  }
  return { built, references, paths };
}

/** The referenced assets of a build, deduplicated by path. */
export function uniqueAssets(references: AssetReferences): AssetReference[] {
  const seen = new Map<string, AssetReference>();
  for (const a of references.assets) if (!seen.has(a.path)) seen.set(a.path, a);
  return [...seen.values()];
}
