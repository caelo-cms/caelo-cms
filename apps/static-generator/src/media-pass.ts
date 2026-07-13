// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — static-generator media pass.
 *
 * Walks every composed page's HTML for `/_caelo/media/<id>/<variant>`
 * URLs, resolves them through `media_variants` to storage keys,
 * copies the bytes from `MEDIA_ROOT_DIR/<storage_key>` into
 * `<buildDir>/_assets/<asset-id>/<variant>.<ext>`, and rewrites the
 * URLs in the HTML so the deployed pages reference `/_assets/...`
 * (served by Caddy as plain static files).
 *
 * Per CLAUDE.md §2 no-fallbacks: a page referencing an asset id that
 * isn't in `media_assets` (or whose variant isn't emitted) raises a
 * structured error tagged with the page slug. The deploy fails loudly
 * rather than emitting broken `<img src>` URLs.
 *
 * CDN copy: if `site_defaults.media_cdn_copy_enabled` is on, the pass
 * also writes `cdn_manifest.json` listing every (asset, variant) used
 * at least `media_cdn_usage_threshold` times. P7 emits the manifest
 * only — the actual upload + URL rewrite to a CDN domain is the P15
 * cloud adapter's job.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  enrichResponsiveImages,
  extractMediaRefs,
  parseVariantWidth,
  variantFamily,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

interface VariantRow {
  asset_id: string;
  variant: string;
  format: string;
  storage_key: string;
  usage_count: number;
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
  // 1. Collect every (assetId, variant) pair referenced across all pages.
  const pairs = new Map<string, Set<string>>(); // assetId → set of variants
  for (const p of args.pages) {
    for (const ref of extractMediaRefs(p.html)) {
      const set = pairs.get(ref.assetId) ?? new Set<string>();
      set.add(ref.variant);
      pairs.set(ref.assetId, set);
    }
  }
  if (pairs.size === 0) {
    return { assetsBytes: 0, manifest: [] };
  }

  // 2. Resolve each pair to a (storage_key, format, usage_count).
  const assetIds = [...pairs.keys()];
  // Per-id query for the same reason as media.list — Bun SQL doesn't
  // reliably splat a JS array into a Postgres array param across all
  // driver versions. The asset count per build is bounded by what the
  // pages actually reference, so the cost is proportional to the
  // working set.
  const rows: VariantRow[] = [];
  for (const id of assetIds) {
    const part = (await args.tx.execute(sql`
      SELECT mv.asset_id::text AS asset_id,
             mv.variant,
             mv.format,
             mv.storage_key,
             ma.usage_count
      FROM media_variants mv
      JOIN media_assets ma ON ma.id = mv.asset_id
      WHERE mv.asset_id = ${id}::uuid
        AND ma.deleted_at IS NULL
    `)) as unknown as VariantRow[];
    rows.push(...part);
  }

  const byPair = new Map<string, VariantRow>();
  for (const r of rows) byPair.set(`${r.asset_id}/${r.variant}`, r);

  // 3. Verify every referenced (asset, variant) pair is resolvable.
  //    Per the no-fallbacks rule this fails the deploy loudly when a
  //    module references a deleted asset.
  const missing: string[] = [];
  for (const [assetId, variants] of pairs) {
    for (const v of variants) {
      if (!byPair.has(`${assetId}/${v}`)) missing.push(`${assetId}/${v}`);
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

  // 4. Copy bytes into _assets/<assetId>/<variant>.<ext>; track total.
  const assetsRoot = join(args.buildDir, "_assets");
  let assetsBytes = 0;
  const manifest: ManifestEntry[] = [];
  const mediaRoot = resolve(args.mediaRoot);

  for (const r of byPair.values()) {
    const ext = formatToExt(r.format);
    const outRel = `_assets/${r.asset_id}/${r.variant}.${ext}`;
    const outPath = join(args.buildDir, outRel);
    await mkdir(join(assetsRoot, r.asset_id), { recursive: true });
    const sourcePath = join(mediaRoot, r.storage_key);
    // Containment guard — storage keys are server-controlled (sha-prefixed)
    // but defence-in-depth.
    const resolvedSource = resolve(sourcePath);
    if (!resolvedSource.startsWith(`${mediaRoot}/`) && resolvedSource !== mediaRoot) {
      throw new Error(`static-generator: storage key escapes mediaRoot: ${r.storage_key}`);
    }
    let bytes: number;
    try {
      const stat = await readFile(resolvedSource);
      bytes = stat.byteLength;
    } catch (e) {
      throw new Error(
        `static-generator: storage object missing for asset=${r.asset_id} variant=${r.variant}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    await copyFile(resolvedSource, outPath);
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

  // 5. Rewrite the HTML. Two passes:
  //    a. <img> tag rewriter — adds srcset / sizes / dims / loading,
  //       and rewrites the src URL to /_assets. Preserves any other
  //       attributes already on the tag (alt, class, style…).
  //    b. Catch-all string rewrite for any remaining /_caelo/media
  //       URLs (CSS background-image, raw mentions in text).
  //    Then if a page references at least one image, emit a
  //    `<link rel="preload" as="image">` for the LCP candidate (first
  //    image in the page) into <head>.
  const variantsByAsset = groupVariantsByAsset(byPair);
  for (const p of args.pages) {
    // issue #162 — shared enrichment (identical markup shape in the
    // editor preview; only the URL form differs).
    p.html = enrichResponsiveImages(p.html, variantsByAsset, {
      rewriteSrc: true,
      urlFor: (assetId, variant, format) => `/_assets/${assetId}/${variant}.${formatToExt(format)}`,
      formatFor: (assetId, variant) =>
        (variantsByAsset.get(assetId) ?? []).find((v) => v.variant === variant)?.format ?? "webp",
    });
    p.html = rewriteCatchAllMediaUrls(p.html, byPair);
    p.html = injectLcpPreload(p.html, variantsByAsset);
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

function formatToExt(format: string): string {
  if (format === "jpeg") return "jpg";
  return format;
}

/**
 * Group variants per asset so we can build srcset entries from the
 * full WebP breakpoint set during the rewrite. Returns a map keyed
 * by assetId; values are sorted by width ASC.
 */
interface VariantInfo {
  variant: string;
  format: string;
}
function groupVariantsByAsset(byPair: Map<string, VariantRow>): Map<string, VariantInfo[]> {
  const out = new Map<string, VariantInfo[]>();
  for (const row of byPair.values()) {
    const list = out.get(row.asset_id) ?? [];
    list.push({ variant: row.variant, format: row.format });
    out.set(row.asset_id, list);
  }
  return out;
}

/**
 * Catch-all rewrite for /_caelo/media URLs that didn't sit inside an
 * `<img src>` (CSS background-image, raw text mentions, attribute
 * values inside other tags). Same target as the previous behaviour.
 */
function rewriteCatchAllMediaUrls(html: string, byPair: Map<string, VariantRow>): string {
  return html.replace(
    /\/_caelo\/media\/([0-9a-f-]{36})\/([a-z][a-z0-9-]{0,63})/g,
    (_match, assetId: string, variant: string) => {
      const row = byPair.get(`${assetId}/${variant}`);
      if (!row) return _match;
      const ext = formatToExt(row.format);
      return `/_assets/${assetId}/${variant}.${ext}`;
    },
  );
}

/**
 * Inject `<link rel="preload" as="image">` for the LCP candidate —
 * the first image in the page. Browser hint: fetches the image with
 * the same priority as critical CSS. Drops a measurable LCP score
 * improvement on heroes-with-images pages.
 */
function injectLcpPreload(html: string, variantsByAsset: Map<string, VariantInfo[]>): string {
  const firstAssetMatch = html.match(/\/_assets\/([0-9a-f-]{36})\/([a-z][a-z0-9-]+)\.[a-z0-9]+/);
  if (!firstAssetMatch) return html;
  const assetId = firstAssetMatch[1] as string;
  const variants = variantsByAsset.get(assetId);
  if (!variants || variants.length === 0) return html;
  const family = variantFamily(firstAssetMatch[2] as string);
  const ladder = variants
    .filter((v) => variantFamily(v.variant) === family && v.format === "webp")
    .map((v) => ({ variant: v.variant, width: parseVariantWidth(v.variant) }))
    .filter((v): v is { variant: string; width: number } => v.width !== null)
    .sort((a, b) => a.width - b.width);
  if (ladder.length === 0) return html;
  const imagesrcset = ladder
    .map((v) => `/_assets/${assetId}/${v.variant}.webp ${v.width}w`)
    .join(", ");
  const tag = `<link rel="preload" as="image" imagesrcset="${imagesrcset}" imagesizes="(max-width: 600px) 400px, (max-width: 1200px) 800px, 1200px" />`;
  // Insert just before </head>; fall back to prepending the document
  // if there's no head (very old templates).
  if (html.includes("</head>")) {
    return html.replace("</head>", `  ${tag}\n  </head>`);
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
