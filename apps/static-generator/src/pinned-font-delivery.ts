// SPDX-License-Identifier: MPL-2.0

/**
 * Delivery for faces pinned in the font registry (theme typography with a
 * `caelo.font` binding).
 *
 * The registry keeps the complete original file; visitors get the WOFF2
 * unicode-range slices `deriveWebDelivery` cuts from it. Deriving costs
 * seconds for a large variable family, so slices are cached on disk under
 * names that carry (source sha256, slice, toolchain tag): a rebuild with
 * the same source and toolchain reuses them byte for byte, and a
 * dependency bump moves to new names instead of serving stale output.
 *
 * Nothing here ever writes the source bytes into the delivery tree. If
 * deriving fails, the `FontDeliveryError` propagates and the caller
 * reports the face as unresolved (the deploy then fails).
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deliveryToolchainTag, deriveWebDelivery } from "@caelo-cms/font-service";

/** One cached slice of a pinned face. */
export interface PinnedSlice {
  readonly subset: string;
  /** `null` when the face ships unsplit (fsType forbids subsetting). */
  readonly unicodeRange: string | null;
  /** Path below the fonts cache / delivery root, e.g. `pinned/<sha>.latin.<tag>.woff2`. */
  readonly relPath: string;
}

interface SliceManifest {
  readonly split: boolean;
  readonly slices: readonly PinnedSlice[];
}

/** (cacheDir, sha, tag) → manifest. Entries are immutable once written. */
const memo = new Map<string, SliceManifest>();

/** Test seam: forget memoised manifests (disk cache stays). */
export function clearPinnedDeliveryMemo(): void {
  memo.clear();
}

/** Write via a unique temp file + rename so a concurrent build never reads half a file. */
async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function readCachedManifest(cacheDir: string, path: string): Promise<SliceManifest | null> {
  let parsed: SliceManifest;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as SliceManifest;
  } catch {
    return null; // not derived yet
  }
  if (!Array.isArray(parsed.slices)) return null;
  try {
    await Promise.all(parsed.slices.map((s) => access(join(cacheDir, s.relPath))));
  } catch {
    return null; // a slice was removed from the cache → derive again
  }
  return parsed;
}

/**
 * Return the delivery slices for a pinned face, deriving and caching them
 * on first use.
 *
 * @param sha256 the registry pin; the caller has already verified `bytes` against it
 * @throws FontDeliveryError when the slices cannot be derived
 */
export async function pinnedFaceSlices(args: {
  readonly cacheDir: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}): Promise<SliceManifest> {
  const tag = deliveryToolchainTag();
  const key = `${args.cacheDir}|${args.sha256}|${tag}`;
  const memoised = memo.get(key);
  if (memoised !== undefined) return memoised;

  const manifestPath = join(args.cacheDir, "pinned", `${args.sha256}.${tag}.json`);
  let manifest = await readCachedManifest(args.cacheDir, manifestPath);
  if (manifest === null) {
    const delivery = await deriveWebDelivery(args.bytes);
    await mkdir(join(args.cacheDir, "pinned"), { recursive: true });
    const slices: PinnedSlice[] = [];
    for (const face of delivery.faces) {
      const relPath = `pinned/${args.sha256}.${face.subset}.${tag}.woff2`;
      await writeAtomic(join(args.cacheDir, relPath), face.bytes);
      slices.push({ subset: face.subset, unicodeRange: face.unicodeRange, relPath });
    }
    manifest = { split: delivery.split, slices };
    // Manifest last: its presence means every slice it names is complete.
    await writeAtomic(manifestPath, JSON.stringify(manifest));
  }
  memo.set(key, manifest);
  return manifest;
}

/** ISO 15924 script → the slice that carries that script's letters. */
const SCRIPT_SLICE: Readonly<Record<string, string>> = {
  Latn: "latin",
  Cyrl: "cyrillic",
  Grek: "greek",
};

/**
 * The slice worth a `<link rel="preload">` for a site written in
 * `language`, or `null` for no preload.
 *
 * Why preload at all: pinned faces are the theme's typography, so the
 * largest above-the-fold text almost always renders in them, and an
 * `@font-face` is only fetched after style calculation finds text that
 * needs it — late enough to cause a visible swap. Why only one slice:
 * with unicode-range the browser fetches just the slices the page uses,
 * so a preloaded slice the page never needs is pure waste (and a console
 * warning). The language's likely script (`de` → Latn, `ru` → Cyrl)
 * names the slice the body text needs; every other slice loads on
 * demand. Languages whose script has no named slice (ja, ar, hi, ...) and
 * unsplit faces get no preload: guessing would trade a sure cost for a
 * possible gain, and an unsplit face can be large.
 */
export function preloadSliceFor(
  language: string | null,
  manifest: SliceManifest,
): PinnedSlice | null {
  if (language === null || !manifest.split) return null;
  let script: string | undefined;
  try {
    script = new Intl.Locale(language).maximize().script;
  } catch {
    return null; // not a well-formed tag; site_language is validated upstream
  }
  const wanted = script === undefined ? undefined : SCRIPT_SLICE[script];
  return manifest.slices.find((s) => s.subset === wanted) ?? null;
}
