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
 *
 * Lives in the static-generator (not admin-core) because admin-core
 * already imports this app for deploy publishing — a resolver in
 * admin-core imported from generate.ts closes a module cycle (madge
 * gate). admin-core re-exports it for the preview op + fonts route.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type FontMetadata, type FontRef, fontRef } from "@caelo-cms/font-service";
import {
  buildFontFaceCss,
  collectPinnedFaces,
  type EffectiveAxisSpec,
  effectiveAxisSpec,
  extractThemeFontRequests,
  type FontAxisPolicy,
  type FontRequest,
  fontFaceProblem,
  fontFamilySlug,
  fontWeightDescriptor,
  googleFontsCssUrl,
  type ParsedFontFace,
  parseFontsCss,
  type ResolvedFontFace,
  type SiteFontUsage,
  selectPreloadFaces,
  servedWeightRange,
  type ThemeDocument,
  type WeightUsage,
} from "@caelo-cms/shared";
import { pinnedFaceSlices, preloadSliceFor } from "./pinned-font-delivery.js";

/**
 * Face bytes are only fetched from the fonts CDN. The srcUrl comes out
 * of a remotely-served CSS payload — without this pin, a compromised or
 * spoofed css2 response could point the server at arbitrary URLs
 * (request-forgery surface).
 */
const ALLOWED_FONT_FILE_HOSTS: ReadonlySet<string> = new Set(["fonts.gstatic.com"]);

/** css2 serves woff2 (+ unicode-range splits) only to modern-browser UAs. */
const WOFF2_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const STATIC_FACE_USAGE: WeightUsage = { weights: null, variationSettingsAxes: [] };

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
  readonly readFont?: (ref: FontRef) => Promise<{ metadata: FontMetadata; bytes: Uint8Array }>;
  /**
   * BCP 47 language the pages are written in; picks which unicode-range
   * slice of each pinned face is preloaded (see `preloadSliceFor`).
   * `null` preloads no pinned slice.
   */
  readonly preloadLanguage: string | null;
  /**
   * Site-wide weight / variation-axis usage (`loadSiteFontUsage`), the
   * input to each pinned face's default axis policy. Called at most once,
   * and only when a pinned face has variation axes. Preview and build
   * pass the same loader so both instance faces identically.
   */
  readonly loadFontUsage: () => Promise<SiteFontUsage>;
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

/** cacheDir|family|w1;w2 → manifest. Process-lifetime; safe because a cache
 *  entry is content-addressed and never rewritten in place. Keyed by the
 *  cache dir too: the manifest only promises files under the dir it was
 *  written to, so a second build with another root (tests, or a process
 *  building several roots) must not inherit paths that do not exist. */
const memo = new Map<string, FamilyManifest>();

function requestKey(cacheDir: string, req: FontRequest): string {
  return `${cacheDir}|${fontFamilySlug(req.family)}|${req.weights.join(";")}`;
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
    const srcHost = new URL(face.srcUrl).host;
    if (!ALLOWED_FONT_FILE_HOSTS.has(srcHost)) {
      throw new Error(`font file host not allowed: ${srcHost} (${face.srcUrl})`);
    }
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
  const pinnedFamilies = new Set<string>();
  const pinnedCss: string[] = [];
  const pinnedPreloads: string[] = [];
  // Several roles may bind the same face; its @font-face rules go out once.
  const emittedPinned = new Set<string>();
  const resolvedFaces: ResolvedFontFace[] = [];
  const files: { cachePath: string; relPath: string }[] = [];
  const unresolved: string[] = [];

  // Axis overrides belong to the face (one file, one @font-face set); a
  // malformed or conflicting override fails every pinned role loudly.
  let overrides: Map<string, FontAxisPolicy | null> | Error;
  try {
    overrides = new Map(collectPinnedFaces(args.tokens).map((f) => [f.ref.sha256, f.override]));
  } catch (error) {
    overrides = error instanceof Error ? error : new Error(String(error));
  }
  let usage: Promise<SiteFontUsage> | null = null;
  const specs = new Map<string, EffectiveAxisSpec>();

  const typography = (args.tokens as Record<string, unknown>).typography;
  if (typography && typeof typography === "object") {
    for (const [role, raw] of Object.entries(typography)) {
      const entry = raw as {
        $extensions?: Record<string, unknown>;
        $value?: { fontFamily?: string; fontWeight?: number | string; fontStyle?: string };
      };
      const binding = entry?.$extensions?.["caelo.font"];
      if (binding === undefined) continue;
      const family = entry.$value?.fontFamily ?? role;
      pinnedFamilies.add(family);
      try {
        const ref = fontRef.parse(binding);
        if (overrides instanceof Error) throw overrides;
        if (!args.readFont) throw new Error("FontReaderUnavailable");
        const { metadata, bytes } = await args.readFont(ref);
        if (
          family !== metadata.cssFamily ||
          !metadata.embedding.web ||
          metadata.sha256 !== ref.sha256 ||
          createHash("sha256").update(bytes).digest("hex") !== ref.sha256
        )
          throw new Error("FontBindingMismatch");
        let spec = specs.get(ref.sha256);
        if (spec === undefined) {
          // A static face has no axis to derive, so it never pays for the
          // site-wide usage scan; the empty usage is never consulted.
          let faceUsage = STATIC_FACE_USAGE;
          if (Object.keys(metadata.axes).length > 0) {
            usage ??= args.loadFontUsage();
            faceUsage = await usage;
          }
          spec = effectiveAxisSpec(
            metadata.axes,
            overrides.get(ref.sha256) ?? null,
            faceUsage,
            metadata.embedding.subset,
          ).spec;
          specs.set(ref.sha256, spec);
        }
        const declaredWeight = entry.$value?.fontWeight ?? metadata.weight;
        const weight =
          declaredWeight === "normal" ? 400 : declaredWeight === "bold" ? 700 : declaredWeight;
        const [servedMin, servedMax] = servedWeightRange(spec, metadata.weight);
        if (typeof weight !== "number" || (entry.$value?.fontStyle ?? "normal") !== metadata.style)
          throw new Error("FontFaceMismatch");
        if (weight < servedMin || weight > servedMax)
          throw new Error(`FontWeightOutsideDelivery:${weight} not in ${servedMin}-${servedMax}`);
        // The registry file is the complete original (often a ~0.9 MB
        // TTF); visitors get WOFF2 unicode-range slices derived from it,
        // instanced to the face's axis spec. A derivation failure throws
        // and lands in `unresolved` below — the raw source is never
        // shipped in its place.
        const delivery = await pinnedFaceSlices({
          cacheDir: args.cacheDir,
          sha256: ref.sha256,
          bytes,
          axisSpec: spec,
        });
        // The descriptor matches the delivered file, so the browser never
        // asks this face for (or synthesizes) a weight it does not carry.
        const fontWeight = fontWeightDescriptor(spec, metadata.weight);
        const slicesToEmit = emittedPinned.has(ref.sha256) ? [] : delivery.slices;
        emittedPinned.add(ref.sha256);
        for (const slice of slicesToEmit) {
          const range = slice.unicodeRange === null ? "" : `unicode-range:${slice.unicodeRange};`;
          pinnedCss.push(
            `@font-face{font-family:${metadata.cssFamily};font-style:${metadata.style};font-weight:${fontWeight};font-display:swap;src:url("${args.publicBasePath}/${slice.relPath}") format("woff2");${range}}`,
          );
          if (!files.some((f) => f.relPath === slice.relPath)) {
            files.push({ cachePath: join(args.cacheDir, slice.relPath), relPath: slice.relPath });
          }
        }
        const preload = preloadSliceFor(args.preloadLanguage, delivery);
        const preloadUrl = preload === null ? null : `${args.publicBasePath}/${preload.relPath}`;
        if (preloadUrl !== null && !pinnedPreloads.includes(preloadUrl)) {
          pinnedPreloads.push(preloadUrl);
        }
        const licensePath = `pinned/${ref.id}.license.txt`;
        if (!files.some((f) => f.relPath === licensePath)) {
          const licenseCache = join(args.cacheDir, licensePath);
          await mkdir(dirname(licenseCache), { recursive: true });
          await writeFile(licenseCache, metadata.license.text);
          files.push({ cachePath: licenseCache, relPath: licensePath });
        }
      } catch (error) {
        unresolved.push(`pinned:${role}:${error instanceof Error ? error.message : "unavailable"}`);
      }
    }
  }

  for (const req of requests) {
    if (pinnedFamilies.has(req.family)) continue;
    if (req.family.startsWith("CaeloFont_")) {
      unresolved.push(req.family);
      continue;
    }
    const key = requestKey(args.cacheDir, req);
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
    const familyFaces: ResolvedFontFace[] = manifest.faces.map((face) => ({
      family: face.family,
      style: face.style,
      weight: face.weight,
      unicodeRange: face.unicodeRange,
      publicUrl: `${args.publicBasePath}/${slug}/${face.fileName}`,
    }));
    // The descriptors come from the remote fonts CSS; one outside the
    // descriptor grammar makes the whole family unresolved (loud), never
    // a scrubbed rule.
    if (familyFaces.some((face) => fontFaceProblem(face) !== null)) {
      unresolved.push(`${req.family}:InvalidFontFace`);
      continue;
    }
    resolvedFaces.push(...familyFaces);
    for (const face of manifest.faces) {
      files.push({
        cachePath: join(args.cacheDir, slug, face.fileName),
        relPath: `${slug}/${face.fileName}`,
      });
    }
  }

  return {
    css: [...pinnedCss, buildFontFaceCss(resolvedFaces)].filter(Boolean).join("\n"),
    preloads: [
      ...pinnedPreloads,
      ...selectPreloadFaces(resolvedFaces).map((f) => f.publicUrl),
    ].slice(0, 2),
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
