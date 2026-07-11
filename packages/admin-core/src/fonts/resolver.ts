// SPDX-License-Identifier: MPL-2.0

/**
 * issue #150 — theme web-font resolver: turns a theme document into
 * self-hosted @font-face CSS + the woff2 files backing it.
 *
 * ONE implementation for both render surfaces (parity contract): the
 * static generator calls it with `publicBasePath: "/_assets/fonts"` and
 * copies the cached files into the build; the preview op calls it with
 * `"/_caelo/fonts"` and the admin serves the cache directly. Network is
 * hit once per (family, weights) — afterwards the disk cache (and a
 * per-process memo) answers, so preview renders stay fast and builds
 * work offline once warmed.
 *
 * Failure model (CLAUDE.md §2): a family that can't be resolved is
 * reported in `unresolved`, never silently skipped. The deploy path
 * throws on non-empty `unresolved`; the preview path surfaces
 * `theme-font-unresolvable:<family>` markers instead — blocking every
 * editor render on fonts-CDN reachability would punish the operator for
 * a network condition, but the miss still lands in the missing-content
 * surface.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildFontFaceCss,
  extractThemeFontRequests,
  type FontRequest,
  fontFamilySlug,
  googleFontsCssUrl,
  type ParsedFontFace,
  parseFontsCss,
  type ResolvedFontFace,
  selectPreloadFaces,
  type ThemeDocument,
} from "@caelo-cms/shared";

/** css2 serves woff2 (+ unicode-range splits) only to modern-browser UAs. */
const WOFF2_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** One face persisted in a family manifest: parse result + cache file. */
interface CachedFace extends Omit<ParsedFontFace, "srcUrl"> {
  readonly fileName: string;
}

interface FamilyManifest {
  readonly faces: readonly CachedFace[];
}

export interface ResolveThemeFontsArgs {
  readonly tokens: ThemeDocument;
  /** Disk cache root (CAELO_FONTS_CACHE_DIR; default data/fonts). */
  readonly cacheDir: string;
  /** URL prefix rendered pages fetch faces from (no trailing slash). */
  readonly publicBasePath: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

export interface ResolvedThemeFonts {
  /** Self-hosted @font-face CSS ("" when only system stacks). */
  readonly css: string;
  /** Preload URLs under publicBasePath. */
  readonly preloads: readonly string[];
  /** Cache files backing the css — the deploy pass copies these. */
  readonly files: readonly { readonly cachePath: string; readonly relPath: string }[];
  /** Families that could not be resolved (fetch/parse failure). */
  readonly unresolved: readonly string[];
}

/** family|w1;w2 → manifest. Process-lifetime; safe because a cache entry
 *  is content-addressed and never rewritten in place. */
const memo = new Map<string, FamilyManifest>();

function requestKey(req: FontRequest): string {
  return `${fontFamilySlug(req.family)}|${req.weights.join(";")}`;
}

function manifestPath(cacheDir: string, req: FontRequest): string {
  const weightsTag = req.weights.join("-");
  return join(cacheDir, fontFamilySlug(req.family), `manifest-${weightsTag}.json`);
}

async function readManifest(path: string): Promise<FamilyManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as FamilyManifest;
    return Array.isArray(parsed.faces) ? parsed : null;
  } catch {
    return null; // absent or corrupt → re-fetch
  }
}

async function fetchFamily(
  req: FontRequest,
  cacheDir: string,
  fetcher: typeof fetch,
): Promise<FamilyManifest> {
  const cssRes = await fetcher(googleFontsCssUrl(req), {
    headers: { "user-agent": WOFF2_UA },
  });
  if (!cssRes.ok) {
    throw new Error(`fonts css request failed with HTTP ${cssRes.status}`);
  }
  const parsed = parseFontsCss(await cssRes.text());
  if (parsed.length === 0) {
    throw new Error("fonts css response contained no @font-face with a woff2 src");
  }
  const familyDir = join(cacheDir, fontFamilySlug(req.family));
  const faces: CachedFace[] = [];
  for (const face of parsed) {
    const fileName = `${createHash("sha256").update(face.srcUrl).digest("hex").slice(0, 16)}.woff2`;
    const target = join(familyDir, fileName);
    const bytesRes = await fetcher(face.srcUrl);
    if (!bytesRes.ok) {
      throw new Error(`font file request failed with HTTP ${bytesRes.status} (${face.srcUrl})`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, new Uint8Array(await bytesRes.arrayBuffer()));
    faces.push({
      family: face.family,
      style: face.style,
      weight: face.weight,
      unicodeRange: face.unicodeRange,
      fileName,
    });
  }
  return { faces };
}

/**
 * Resolve every web-font family the theme references. Per-family
 * failures land in `unresolved`; successfully resolved families still
 * produce css so a single broken family doesn't take down the rest.
 */
export async function resolveThemeFonts(args: ResolveThemeFontsArgs): Promise<ResolvedThemeFonts> {
  const fetcher = args.fetcher ?? fetch;
  const requests = extractThemeFontRequests(args.tokens);
  const resolvedFaces: ResolvedFontFace[] = [];
  const files: { cachePath: string; relPath: string }[] = [];
  const unresolved: string[] = [];

  for (const req of requests) {
    const key = requestKey(req);
    let manifest = memo.get(key) ?? null;
    if (manifest === null) {
      const mPath = manifestPath(args.cacheDir, req);
      manifest = await readManifest(mPath);
      if (manifest === null) {
        try {
          manifest = await fetchFamily(req, args.cacheDir, fetcher);
          await mkdir(dirname(mPath), { recursive: true });
          await writeFile(mPath, JSON.stringify(manifest, null, 2));
        } catch {
          unresolved.push(req.family);
          continue;
        }
      }
      memo.set(key, manifest);
    }
    const slug = fontFamilySlug(req.family);
    for (const face of manifest.faces) {
      resolvedFaces.push({
        family: face.family,
        style: face.style,
        weight: face.weight,
        unicodeRange: face.unicodeRange,
        publicUrl: `${args.publicBasePath}/${slug}/${face.fileName}`,
      });
      files.push({
        cachePath: join(args.cacheDir, slug, face.fileName),
        relPath: `${slug}/${face.fileName}`,
      });
    }
  }

  return {
    css: resolvedFaces.length > 0 ? buildFontFaceCss(resolvedFaces) : "",
    preloads: selectPreloadFaces(resolvedFaces).map((f) => f.publicUrl),
    files,
    unresolved,
  };
}

/** Default cache root shared by preview (admin) and deploy (static-gen). */
export function defaultFontsCacheDir(rootDir: string): string {
  return join(rootDir, process.env.CAELO_FONTS_CACHE_DIR ?? "data/fonts");
}

/** Test seam: drop the per-process memo (cache files stay). */
export function clearFontResolverMemo(): void {
  memo.clear();
}
