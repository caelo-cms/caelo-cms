// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — static-generator media pass.
 *
 * Walks every composed page's HTML for `/_caelo/media/<ref>[/<variant>]`
 * URLs (where `<ref>` is the asset SLUG for current embeds, or a legacy
 * UUID id for pre-slug content), resolves them through `media_assets` +
 * `media_variants` to storage keys, copies the bytes from
 * `MEDIA_ROOT_DIR/<storage_key>` into the build's `_assets/` tree, and
 * rewrites the URLs in the HTML so the deployed pages reference
 * `/_assets/...` (served by Caddy as plain static files).
 *
 * Output-path scheme (issue: meaningful media URLs, id internal; #667:
 * content-hashed so every provider can cache them forever — see
 * media-asset-path.ts):
 *   - slug ref, orig variant  → `_assets/<slug>.<hash>.<ext>`           (FLAT)
 *   - slug ref, named variant → `_assets/<slug>/<variant>.<hash>.<ext>` (nested)
 *   - legacy id ref           → `_assets/<id>/<variant>.<hash>.<ext>`   (old shape)
 * so a plain image reads as a name (`/_assets/searchviu-logo.3f9a….png`)
 * while the UUID stays internal.
 *
 * Per CLAUDE.md §2 no-fallbacks: a page referencing a slug/id that isn't
 * in `media_assets` (or whose variant isn't emitted) raises a structured
 * error tagged with the missing ref/variant. The deploy fails loudly
 * rather than emitting broken `<img src>` URLs.
 *
 * CDN copy: if `site_defaults.media_cdn_copy_enabled` is on, the pass
 * also writes `cdn_manifest.json` listing every (asset, variant) used
 * at least `media_cdn_usage_threshold` times. P7 emits the manifest
 * only — the actual upload + URL rewrite to a CDN domain is the P15
 * cloud adapter's job.
 */

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  enrichResponsiveImages,
  extractMediaRefs,
  type ImageVariantInfo,
  parseVariantWidth,
  variantFamily,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { readStoredMedia, writePublishedMedia } from "./media-asset-path.js";

/** Full-uuid shape — tells a legacy id ref from a slug ref (mirrors shared). */
const MEDIA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface VariantRow {
  asset_id: string;
  /** The asset's library identity, for the missing-file error. */
  slug: string;
  original_name: string;
  source_kind: string | null;
  source_detail: string | null;
  variant: string;
  format: string;
  width: number | null;
  storage_key: string;
  usage_count: number;
  visibility: "library" | "reference";
}

/**
 * A resolved media reference: the `ref` string as it appears in the HTML
 * (slug when `isSlug`, legacy uuid otherwise), its internal asset id, and
 * every emitted variant of that asset keyed by variant tag.
 */
interface ResolvedRef {
  ref: string;
  isSlug: boolean;
  variants: Map<string, VariantRow>;
}

interface MediaSettings {
  cdnEnabled: boolean;
  threshold: number;
}

interface ManifestEntry {
  assetId: string;
  variant: string;
  format: string;
  outputPath: string;
  bytes: number;
  usageCount: number;
}

/**
 * Run the media pass over a set of composed pages, mutating each
 * page's HTML in-place to swap /_caelo/media/... URLs for /_assets/...
 * and copying the referenced variants into the build directory.
 *
 * Returns the manifest entry list (used for `cdn_manifest.json`) and
 * the number of bytes written to `_assets/`. Caller writes the page
 * HTML and the manifest.
 */
export async function runMediaPass(args: {
  tx: TransactionRunner;
  buildDir: string;
  pages: { html: string; pageSlug: string }[];
  /** Absolute filesystem path to the storage root (`MEDIA_ROOT_DIR`). */
  mediaRoot: string;
  settings: MediaSettings;
}): Promise<{ assetsBytes: number; manifest: ManifestEntry[] }> {
  // 1. Collect every (ref, variant) referenced across all pages. `ref` is
  //    a slug (current embeds) or a legacy uuid id; the two never collide
  //    since the ref string IS the map key.
  const refs = new Map<string, { isSlug: boolean; variants: Set<string> }>();
  for (const p of args.pages) {
    for (const r of extractMediaRefs(p.html)) {
      const entry = refs.get(r.ref) ?? { isSlug: r.isSlug, variants: new Set<string>() };
      entry.variants.add(r.variant);
      refs.set(r.ref, entry);
    }
  }
  if (refs.size === 0) {
    return { assetsBytes: 0, manifest: [] };
  }

  // 2. Resolve each ref to its asset's variant rows. Slug refs resolve via
  //    `media_assets.slug` (unique among live rows); legacy id refs resolve
  //    by asset id as before.
  //    Per-ref query for the same reason as media.list — Bun SQL doesn't
  //    reliably splat a JS array into a Postgres array param across all
  //    driver versions. The ref count per build is bounded by what the
  //    pages actually reference, so the cost is proportional to the
  //    working set.
  const resolved = new Map<string, ResolvedRef>();
  for (const [ref, info] of refs) {
    const rows = (info.isSlug
      ? await args.tx.execute(sql`
            SELECT mv.asset_id::text AS asset_id,
                   ma.slug, ma.original_name, ma.source_kind, ma.source_detail,
                   mv.variant,
                   mv.format,
                   mv.width,
                   mv.storage_key,
                   ma.usage_count,
                   ma.visibility
            FROM media_assets ma
            JOIN media_variants mv ON mv.asset_id = ma.id
            WHERE ma.slug = ${ref}
              AND ma.deleted_at IS NULL
          `)
      : await args.tx.execute(sql`
            SELECT mv.asset_id::text AS asset_id,
                   ma.slug, ma.original_name, ma.source_kind, ma.source_detail,
                   mv.variant,
                   mv.format,
                   mv.width,
                   mv.storage_key,
                   ma.usage_count,
                   ma.visibility
            FROM media_variants mv
            JOIN media_assets ma ON ma.id = mv.asset_id
            WHERE mv.asset_id = ${ref}::uuid
              AND ma.deleted_at IS NULL
          `)) as unknown as VariantRow[];
    const variants = new Map<string, VariantRow>();
    for (const r of rows) variants.set(r.variant, r);
    resolved.set(ref, { ref, isSlug: info.isSlug, variants });
  }

  // #531 — a reference image guides generation/editing and never ships
  // on a page. Refuse loudly with the fix, rather than publishing it.
  const references = [...resolved.values()]
    .filter((r) => [...r.variants.values()].some((v) => v.visibility === "reference"))
    .map((r) => r.ref);
  if (references.length > 0) {
    throw new Error(
      `static-generator: pages reference media marked as reference images: ${references.join(", ")}. ` +
        "Reference images guide image generation/editing and are never published. Next step: either " +
        "replace them in the page/module HTML with a library image (find_media), or, if the operator " +
        "wants them on the page, mark them as library images (AI tool: set_media_visibility_many with " +
        'visibility: "library").',
    );
  }

  // 3. Verify every referenced (ref, variant) is resolvable. Per the
  //    no-fallbacks rule this fails the deploy loudly when a module
  //    references a deleted asset or an unemitted variant.
  const missing: string[] = [];
  for (const [ref, info] of refs) {
    const res = resolved.get(ref);
    for (const v of info.variants) {
      if (!res?.variants.has(v)) missing.push(`${ref}/${v}`);
    }
  }
  if (missing.length > 0) {
    // run #10 D4 — AI-actionable failure surface (CLAUDE.md §11): name
    // the recovery op, and the by-design case where recovery means
    // re-pointing the HTML instead (source narrower than the
    // breakpoint / animated GIF — the pipeline never upscales).
    throw new Error(
      `static-generator: media references unresolved (asset/variant pairs missing): ${missing.join(", ")}. ` +
        "Next step: run media.regenerate_variants (AI tool: regenerate_media_variants) with these asset ids " +
        "to re-run the image pipeline. If a variant still cannot be produced (source image narrower than " +
        "the breakpoint, animated GIF, or non-raster kind), edit the referencing module HTML to use the " +
        "result's bestUrl (e.g. /orig) — find the modules via media.list_usages.",
    );
  }

  // 4. Copy bytes into the slug-based (or legacy id-based) `_assets/`
  //    layout under content-hashed names (#667); track total. Every
  //    emitted variant of each referenced asset is copied — the srcset
  //    enrichment below needs the full breakpoint ladder even when the
  //    HTML only names orig.
  let assetsBytes = 0;
  const manifest: ManifestEntry[] = [];
  const mediaRoot = resolve(args.mediaRoot);
  // Every asset whose stored file is gone, collected so one failed Stage
  // names all of them instead of one per attempt.
  const missingFiles = new Map<string, { row: VariantRow; variants: string[] }>();
  // `${ref}|${variant}` → published build-relative path. The hash in the
  // name comes from the bytes, so URLs can only be built after the copy.
  const publishedPaths = new Map<string, string>();

  for (const res of resolved.values()) {
    for (const r of res.variants.values()) {
      const body = await readStoredMedia(mediaRoot, r.storage_key);
      if (body === null) {
        const entry = missingFiles.get(r.asset_id) ?? { row: r, variants: [] };
        entry.variants.push(r.variant);
        missingFiles.set(r.asset_id, entry);
        continue;
      }
      if (missingFiles.size > 0) continue;
      const outRel = await writePublishedMedia({
        buildDir: args.buildDir,
        ref: res.ref,
        isSlug: res.isSlug,
        variant: r.variant,
        format: r.format,
        bytes: body,
      });
      publishedPaths.set(publishedKey(res.ref, r.variant), outRel);
      const bytes = body.byteLength;
      assetsBytes += bytes;
      if (args.settings.cdnEnabled && r.usage_count >= args.settings.threshold) {
        manifest.push({
          assetId: r.asset_id,
          variant: r.variant,
          format: r.format,
          outputPath: outRel,
          bytes,
          usageCount: r.usage_count,
        });
      }
    }
  }
  if (missingFiles.size > 0) {
    throw new Error(missingMediaFilesError([...missingFiles.values()], mediaRoot));
  }

  // 5. Rewrite the HTML. Two passes:
  //    a. <img> tag rewriter — adds srcset / sizes / dims / loading,
  //       and rewrites the src URL to /_assets. Preserves any other
  //       attributes already on the tag (alt, class, style…).
  //    b. Catch-all string rewrite for any remaining /_caelo/media
  //       URLs (CSS background-image, raw mentions in text).
  //    Then if a page references at least one image, emit a
  //    `<link rel="preload" as="image">` for the LCP candidate (first
  //    image in the page) into <head>.
  const variantsByRef = groupVariantsByRef(resolved);
  // Build the public `/_assets/…` URL for a ref+variant, honouring the
  // slug-flat / variant-nested / legacy-id split. `ref` here is the same
  // string enrichResponsiveImages parsed out of the src (slug or uuid).
  const urlForRef = (ref: string, variant: string, _format: string): string => {
    const path = publishedPaths.get(publishedKey(ref, variant));
    if (path === undefined) {
      // No-fallbacks: every img media ref was extracted, resolved and
      // copied above.
      throw new Error(
        `static-generator: media ref ${ref}/${variant} unpublished during URL rewrite`,
      );
    }
    return `/${path}`;
  };
  for (const p of args.pages) {
    // issue #162 — shared enrichment (identical markup shape in the
    // editor preview; only the URL form differs).
    p.html = enrichResponsiveImages(p.html, variantsByRef, {
      rewriteSrc: true,
      urlFor: urlForRef,
      formatFor: (ref, variant) =>
        (variantsByRef.get(ref) ?? []).find((v) => v.variant === variant)?.format ?? "webp",
    });
    p.html = rewriteCatchAllMediaUrls(p.html, publishedPaths);
    p.html = injectLcpPreload(p.html, variantsByRef, publishedPaths);
  }

  // 6. Emit cdn_manifest.json (always — empty array when CDN copy is off).
  await writeFile(
    join(args.buildDir, "cdn_manifest.json"),
    JSON.stringify(
      { enabled: args.settings.cdnEnabled, threshold: args.settings.threshold, entries: manifest },
      null,
      2,
    ),
    "utf8",
  );

  return { assetsBytes, manifest };
}

/**
 * The Stage failure for media whose stored files are gone (the library row
 * exists, the bytes do not — e.g. media written to a cloud container's
 * ephemeral disk before the media bucket was mounted). Names each asset the
 * way the operator and the AI know it, and the way back (CLAUDE.md §11).
 */
function missingMediaFilesError(
  missing: readonly { row: VariantRow; variants: readonly string[] }[],
  mediaRoot: string,
): string {
  const assets = missing.map(({ row, variants }) => {
    const source =
      row.source_kind === "imported" && row.source_detail
        ? `, imported from ${row.source_detail}`
        : row.source_kind
          ? `, source: ${row.source_kind}`
          : "";
    return `"${row.original_name}" (${buildMediaUrl(row.slug, "orig")}, id ${row.asset_id}${source}; missing: ${variants.join(", ")})`;
  });
  return (
    `static-generator: the stored files of ${missing.length} media asset(s) are missing from ${mediaRoot}: ${assets.join("; ")}. ` +
    "The library rows exist but the image files are gone, so these cannot be published. Next step: list every affected asset " +
    "with list_missing_media, then for each one either restore it — re-import it with import_media_from_urls when it came from a URL, " +
    "or ask the operator to re-upload the same file at /content/media (identical files reuse the asset, so every page " +
    "referencing it is fixed) — or remove it from the pages that use it (find them via media.list_usages) and delete it " +
    "with delete_media_many."
  );
}

/** Key of `publishedPaths`: the ref as written in the HTML + the variant. */
function publishedKey(ref: string, variant: string): string {
  return `${ref}|${variant}`;
}

/**
 * Group variants per ref (slug or legacy id) so we can build srcset
 * entries from the full WebP breakpoint set during the rewrite. Returns
 * a map keyed by the ref string as it appears in the HTML.
 */
function groupVariantsByRef(resolved: Map<string, ResolvedRef>): Map<string, ImageVariantInfo[]> {
  const out = new Map<string, ImageVariantInfo[]>();
  for (const [ref, res] of resolved) {
    out.set(
      ref,
      [...res.variants.values()].map((row) => ({
        variant: row.variant,
        format: row.format,
        width: row.width,
      })),
    );
  }
  return out;
}

/**
 * Catch-all rewrite for /_caelo/media URLs that didn't sit inside an
 * `<img src>` (CSS background-image, raw text mentions, attribute values
 * inside other tags). Handles both the current slug form
 * (`/_caelo/media/<slug>[/<variant>]`) and the legacy
 * `/_caelo/media/<uuid>/<variant>` form, routing each to the matching
 * `/_assets/...` URL via the resolution map.
 */
function rewriteCatchAllMediaUrls(
  html: string,
  publishedPaths: ReadonlyMap<string, string>,
): string {
  return html.replace(
    /\/_caelo\/media\/([a-z0-9][a-z0-9-]{0,63})(?:\/([a-z][a-z0-9-]{0,63}))?/g,
    (_match, seg1: string, seg2: string | undefined) => {
      // Same classification as extractMediaRefs: a full-uuid first segment
      // with an explicit variant is the legacy id form; else it's a slug
      // (orig implied when no variant).
      const isLegacyId = MEDIA_UUID_RE.test(seg1) && seg2 !== undefined;
      const variant = isLegacyId ? (seg2 as string) : (seg2 ?? "orig");
      const path = publishedPaths.get(publishedKey(seg1, variant));
      return path === undefined ? _match : `/${path}`;
    },
  );
}

/**
 * Inject `<link rel="preload" as="image">` for the LCP candidate —
 * the first image in the page. Browser hint: fetches the image with
 * the same priority as critical CSS. Drops a measurable LCP score
 * improvement on heroes-with-images pages.
 *
 * The ref is the first `_assets` path segment; the preload srcset takes
 * every ladder entry's published (content-hashed) path from the copy step.
 */
function injectLcpPreload(
  html: string,
  variantsByRef: Map<string, ImageVariantInfo[]>,
  publishedPaths: ReadonlyMap<string, string>,
): string {
  // Match flat (`_assets/<slug>.<hash>.png`) and nested
  // (`_assets/<ref>/<variant>.<hash>.webp`) image URLs; the image-only extension
  // set keeps font files (`_assets/fonts/*.woff2`) from short-circuiting.
  // `<link>` tags are skipped: they reference media that is never painted
  // content (the theme's `<link rel="icon">`), and a PNG favicon there
  // would otherwise win "first image" and suppress the hero's preload.
  // Head `<style>` stays in the scan so a CSS-background hero still counts,
  // and no `<body>` tag is required (layouts need not carry one).
  const scanned = html.replace(/<link\b[^>]*>/gi, "");
  const firstAssetMatch = scanned.match(
    /\/_assets\/([a-z0-9][a-z0-9-]{0,63})(?:\/([a-z][a-z0-9-]{0,63}))?\.[0-9a-f]{16}\.(?:png|jpe?g|webp|avif|gif)/,
  );
  if (!firstAssetMatch) return html;
  // #667 — when the first image is an `<img>` that carries its own
  // srcset + sizes, preload exactly that pair, so the preload fetches the
  // file the image will select (a fixed `imagesizes` preloaded an 800px
  // WebP for a logo whose `sizes="160px"` picks the 400px one).
  const own = ownResponsivePair(scanned, firstAssetMatch.index ?? 0);
  if (own) return insertPreload(html, own.srcset, own.sizes);
  const ref = firstAssetMatch[1] as string;
  const variants = variantsByRef.get(ref);
  if (!variants || variants.length === 0) return html;
  const family = variantFamily((firstAssetMatch[2] as string | undefined) ?? "orig");
  const ladder = variants
    .filter((v) => variantFamily(v.variant) === family && v.format === "webp")
    .map((v) => ({ variant: v.variant, width: parseVariantWidth(v.variant) }))
    .filter((v): v is { variant: string; width: number } => v.width !== null)
    .sort((a, b) => a.width - b.width);
  if (ladder.length === 0) return html;
  const imagesrcset = ladder
    .map((v) => {
      const path = publishedPaths.get(publishedKey(ref, v.variant));
      if (path === undefined) {
        throw new Error(
          `static-generator: media ref ${ref}/${v.variant} unpublished during preload`,
        );
      }
      return `/${path} ${v.width}w`;
    })
    .join(", ");
  return insertPreload(
    html,
    imagesrcset,
    "(max-width: 600px) 400px, (max-width: 1200px) 800px, 1200px",
  );
}

/** The srcset/sizes of the `<img>` tag containing position `at`, when it has both. */
function ownResponsivePair(html: string, at: number): { srcset: string; sizes: string } | null {
  const start = html.lastIndexOf("<", at);
  if (start === -1 || !/^<img\b/i.test(html.slice(start, start + 5))) return null;
  const end = html.indexOf(">", at);
  if (end === -1) return null;
  const tag = html.slice(start, end + 1);
  const srcset = tag.match(/\ssrcset="([^"]*)"/i)?.[1];
  const sizes = tag.match(/\ssizes="([^"]*)"/i)?.[1];
  return srcset && sizes ? { srcset, sizes } : null;
}

/** Insert an image preload just before `</head>` (or prepend it without a head). */
function insertPreload(html: string, imagesrcset: string, imagesizes: string): string {
  const tag = `<link rel="preload" as="image" imagesrcset="${imagesrcset}" imagesizes="${imagesizes}" />`;
  if (html.includes("</head>")) {
    return html.replace("</head>", () => `  ${tag}\n  </head>`);
  }
  return tag + html;
}

/**
 * Read the CDN settings from `site_defaults` for the deploy run.
 * Defaults to off when the row is unseeded — same semantics as
 * `media.get_settings` in the admin op layer, but read from the
 * generator's own tx without an op detour.
 */
export async function readMediaSettings(tx: TransactionRunner): Promise<MediaSettings> {
  const rows = (await tx.execute(sql`
    SELECT media_cdn_copy_enabled AS cdn_copy_enabled,
           media_cdn_usage_threshold AS cdn_usage_threshold
    FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { cdn_copy_enabled: boolean; cdn_usage_threshold: number }[];
  const r = rows[0];
  return {
    cdnEnabled: r?.cdn_copy_enabled ?? false,
    threshold: r?.cdn_usage_threshold ?? 5,
  };
}
