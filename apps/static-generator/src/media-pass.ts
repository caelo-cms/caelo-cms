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
 * Output-path scheme (issue: meaningful media URLs, id internal):
 *   - slug ref, orig variant  → `_assets/<slug>.<ext>`         (FLAT)
 *   - slug ref, named variant → `_assets/<slug>/<variant>.<ext>` (nested)
 *   - legacy id ref           → `_assets/<id>/<variant>.<ext>`   (old shape)
 * so a plain image reads as a name (`/_assets/searchviu-logo.png`) while
 * the UUID stays internal; legacy embeds keep resolving byte-for-byte.
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

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  enrichResponsiveImages,
  extractMediaRefs,
  parseVariantWidth,
  variantFamily,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** Full-uuid shape — tells a legacy id ref from a slug ref (mirrors shared). */
const MEDIA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface VariantRow {
  asset_id: string;
  variant: string;
  format: string;
  storage_key: string;
  usage_count: number;
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

/**
 * Public `_assets/…` relative path (no leading slash) for a ref+variant.
 * Slug orig is flat (`_assets/<slug>.<ext>`); named slug variants nest
 * under the slug; legacy id refs keep the `_assets/<id>/<variant>.<ext>`
 * shape. The public URL is this string with a leading `/`.
 */
function assetRelPath(ref: string, isSlug: boolean, variant: string, ext: string): string {
  if (isSlug && variant === "orig") return `_assets/${ref}.${ext}`;
  return `_assets/${ref}/${variant}.${ext}`;
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
                   mv.variant,
                   mv.format,
                   mv.storage_key,
                   ma.usage_count
            FROM media_assets ma
            JOIN media_variants mv ON mv.asset_id = ma.id
            WHERE ma.slug = ${ref}
              AND ma.deleted_at IS NULL
          `)
      : await args.tx.execute(sql`
            SELECT mv.asset_id::text AS asset_id,
                   mv.variant,
                   mv.format,
                   mv.storage_key,
                   ma.usage_count
            FROM media_variants mv
            JOIN media_assets ma ON ma.id = mv.asset_id
            WHERE mv.asset_id = ${ref}::uuid
              AND ma.deleted_at IS NULL
          `)) as unknown as VariantRow[];
    const variants = new Map<string, VariantRow>();
    for (const r of rows) variants.set(r.variant, r);
    resolved.set(ref, { ref, isSlug: info.isSlug, variants });
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
  //    layout; track total. Every emitted variant of each referenced
  //    asset is copied — the srcset enrichment below needs the full
  //    breakpoint ladder even when the HTML only names orig.
  let assetsBytes = 0;
  const manifest: ManifestEntry[] = [];
  const mediaRoot = resolve(args.mediaRoot);

  for (const res of resolved.values()) {
    for (const r of res.variants.values()) {
      const ext = formatToExt(r.format);
      const outRel = assetRelPath(res.ref, res.isSlug, r.variant, ext);
      const outPath = join(args.buildDir, outRel);
      await mkdir(dirname(outPath), { recursive: true });
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
  const urlForRef = (ref: string, variant: string, format: string): string => {
    const res = resolved.get(ref);
    if (!res) {
      // No-fallbacks: every img media ref was extracted + resolved above.
      throw new Error(`static-generator: media ref ${ref} unresolved during URL rewrite`);
    }
    return `/${assetRelPath(ref, res.isSlug, variant, formatToExt(format))}`;
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
    p.html = rewriteCatchAllMediaUrls(p.html, resolved);
    p.html = injectLcpPreload(p.html, variantsByRef);
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
 * Group variants per ref (slug or legacy id) so we can build srcset
 * entries from the full WebP breakpoint set during the rewrite. Returns
 * a map keyed by the ref string as it appears in the HTML.
 */
interface VariantInfo {
  variant: string;
  format: string;
}
function groupVariantsByRef(resolved: Map<string, ResolvedRef>): Map<string, VariantInfo[]> {
  const out = new Map<string, VariantInfo[]>();
  for (const [ref, res] of resolved) {
    out.set(
      ref,
      [...res.variants.values()].map((row) => ({ variant: row.variant, format: row.format })),
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
function rewriteCatchAllMediaUrls(html: string, resolved: Map<string, ResolvedRef>): string {
  return html.replace(
    /\/_caelo\/media\/([a-z0-9][a-z0-9-]{0,63})(?:\/([a-z][a-z0-9-]{0,63}))?/g,
    (_match, seg1: string, seg2: string | undefined) => {
      // Same classification as extractMediaRefs: a full-uuid first segment
      // with an explicit variant is the legacy id form; else it's a slug
      // (orig implied when no variant).
      const isLegacyId = MEDIA_UUID_RE.test(seg1) && seg2 !== undefined;
      const isSlug = !isLegacyId;
      const variant = isSlug ? (seg2 ?? "orig") : (seg2 as string);
      const res = resolved.get(seg1);
      const row = res?.variants.get(variant);
      if (!res || !row) return _match;
      return `/${assetRelPath(seg1, isSlug, variant, formatToExt(row.format))}`;
    },
  );
}

/**
 * Inject `<link rel="preload" as="image">` for the LCP candidate —
 * the first image in the page. Browser hint: fetches the image with
 * the same priority as critical CSS. Drops a measurable LCP score
 * improvement on heroes-with-images pages.
 *
 * WebP breakpoint variants are always nested (`_assets/<ref>/<variant>.webp`)
 * regardless of the slug/legacy-id split, so the preload srcset uses the
 * ref (first `_assets` path segment) directly.
 */
function injectLcpPreload(html: string, variantsByRef: Map<string, VariantInfo[]>): string {
  // Match flat (`_assets/<slug>.png`) and nested
  // (`_assets/<ref>/<variant>.webp`) image URLs; the image-only extension
  // set keeps font files (`_assets/fonts/*.woff2`) from short-circuiting.
  const firstAssetMatch = html.match(
    /\/_assets\/([a-z0-9][a-z0-9-]{0,63})(?:\/([a-z][a-z0-9-]{0,63}))?\.(?:png|jpe?g|webp|avif|gif)/,
  );
  if (!firstAssetMatch) return html;
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
  const imagesrcset = ladder.map((v) => `/_assets/${ref}/${v.variant}.webp ${v.width}w`).join(", ");
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
