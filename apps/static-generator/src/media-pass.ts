// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — static-generator media pass.
 *
 * Walks every composed page's HTML for `/_caelo/media/<ref>[/<variant>]`
 * URLs (where `<ref>` is the asset SLUG for current embeds, or a legacy
 * UUID id for pre-slug content), resolves them through `media_assets` +
 * `media_variants`, and rewrites the URLs so the deployed pages reference
 * `/_assets/...`.
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
 * #1271 — the pass reads no media byte. The hash in the name is the stored
 * `media_variants.content_sha256` (migration 0443), and each published file
 * becomes an asset reference (asset-references.ts) the publisher delivers
 * from the media store: Firebase and GCS upload only what the provider
 * lacks, self-hosted hard-links it into the build ({@link MediaDelivery}).
 * The pass runs page batch by page batch (generate.ts) and resolves each
 * media ref once, the first time a batch references it, so its memory is
 * the resolved refs, never the pages or the files.
 *
 * Per CLAUDE.md §2 no-fallbacks: a page referencing a slug/id that isn't
 * in `media_assets` (or whose variant isn't emitted), a variant whose
 * stored file is gone and a variant without stored digests each raise a
 * structured, AI-actionable error. The deploy fails loudly rather than
 * emitting broken `<img src>` URLs.
 *
 * CDN copy: if `site_defaults.media_cdn_copy_enabled` is on, the pass
 * also writes `cdn_manifest.json` listing every (asset, variant) used
 * at least `media_cdn_usage_threshold` times. P7 emits the manifest
 * only — the actual upload + URL rewrite to a CDN domain is the P15
 * cloud adapter's job.
 */

import { copyFile, link, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  enrichResponsiveImages,
  extractMediaRefs,
  type ImageVariantInfo,
  parseVariantWidth,
  runBatched,
  variantFamily,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { AssetReference } from "./asset-references.js";
import { mediaAssetRelPath, mediaContentHash } from "./media-asset-path.js";

/** Full-uuid shape — tells a legacy id ref from a slug ref (mirrors shared). */
const MEDIA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stored files checked (stat / link) at once: metadata I/O, gcsfuse on GCP. */
const FS_PARALLELISM = 32;

/**
 * How the build gets the media files it references. `reference`: it lists
 * them and the publisher uploads what the provider lacks (Firebase, GCS).
 * `link`: they are hard-linked into the build directory, which the serving
 * layer reads (self-hosted `current/`).
 */
export type MediaDelivery = "reference" | "link";

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
  size_bytes: number | string;
  usage_count: number;
  visibility: "library" | "reference";
  content_sha256: string | null;
  gzip_sha256: string | null;
  gzip_size: number | string | null;
  digest_profile: string | null;
  /** The ref as written in the HTML (slug or legacy id) this row was loaded for. */
  ref: string;
}

/** A resolved media reference: every emitted variant of its asset, keyed by tag. */
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

/** A JSON value bound as one jsonb parameter. */
function jsonb(value: unknown): ReturnType<typeof sql> {
  return sql`(${JSON.stringify(value)}::text)::jsonb`;
}

const VARIANT_COLUMNS = sql`
  mv.asset_id::text AS asset_id,
  ma.slug, ma.original_name, ma.source_kind, ma.source_detail,
  mv.variant, mv.format, mv.width, mv.storage_key, mv.size_bytes,
  ma.usage_count, ma.visibility,
  mv.content_sha256, mv.gzip_sha256, mv.gzip_size, mv.digest_profile`;

/**
 * The media of one build: resolves refs batch by batch, rewrites the
 * pages' media URLs, and collects the files the build references.
 */
export class MediaPass {
  readonly #tx: TransactionRunner;
  readonly #buildDir: string;
  readonly #mediaRoot: string;
  readonly #settings: MediaSettings;
  readonly #delivery: MediaDelivery;
  readonly #resolved = new Map<string, ResolvedRef>();
  /** `${ref}|${variant}` → published build-relative path. */
  readonly #published = new Map<string, string>();
  /** Published path → the file it references. */
  readonly #assets = new Map<string, AssetReference>();
  readonly #variantsByRef = new Map<string, ImageVariantInfo[]>();
  readonly #cdnManifest = new Map<string, ManifestEntry>();

  constructor(args: {
    tx: TransactionRunner;
    buildDir: string;
    /** Absolute filesystem path to the storage root (`MEDIA_ROOT_DIR`). */
    mediaRoot: string;
    settings: MediaSettings;
    delivery: MediaDelivery;
  }) {
    this.#tx = args.tx;
    this.#buildDir = args.buildDir;
    this.#mediaRoot = resolve(args.mediaRoot);
    this.#settings = args.settings;
    this.#delivery = args.delivery;
  }

  /** The files the build references so far, by published path. */
  assets(): AssetReference[] {
    return [...this.#assets.values()];
  }

  /**
   * Rewrite one batch of pages in place: resolve the refs no earlier batch
   * had, publish their variants, then swap every `/_caelo/media/...` URL
   * for its `/_assets/...` path (with srcset, dimensions and the LCP
   * preload, exactly as the editor preview enriches it).
   */
  async rewritePages(pages: { html: string; pageSlug: string }[]): Promise<void> {
    // 1. Every (ref, variant) the batch references. `ref` is a slug (current
    //    embeds) or a legacy uuid id; the two never collide since the ref
    //    string IS the map key.
    const refs = new Map<string, { isSlug: boolean; variants: Set<string> }>();
    for (const p of pages) {
      for (const r of extractMediaRefs(p.html)) {
        const entry = refs.get(r.ref) ?? { isSlug: r.isSlug, variants: new Set<string>() };
        entry.variants.add(r.variant);
        refs.set(r.ref, entry);
      }
    }
    if (refs.size === 0) return;
    await this.#resolve([...refs].filter(([ref]) => !this.#resolved.has(ref)));

    // 2. Verify every referenced (ref, variant) is resolvable. Per the
    //    no-fallbacks rule this fails the deploy loudly when a module
    //    references a deleted asset or an unemitted variant.
    const missing: string[] = [];
    for (const [ref, info] of refs) {
      const res = this.#resolved.get(ref);
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

    // 3. Rewrite the HTML. Two passes:
    //    a. <img> tag rewriter — adds srcset / sizes / dims / loading,
    //       and rewrites the src URL to /_assets. Preserves any other
    //       attributes already on the tag (alt, class, style…).
    //    b. Catch-all string rewrite for any remaining /_caelo/media
    //       URLs (CSS background-image, raw mentions in text).
    //    Then if a page references at least one image, emit a
    //    `<link rel="preload" as="image">` for the LCP candidate (first
    //    image in the page) into <head>.
    const urlForRef = (ref: string, variant: string, _format: string): string => {
      const path = this.#published.get(publishedKey(ref, variant));
      if (path === undefined) {
        // No-fallbacks: every img media ref was extracted, resolved and
        // published above.
        throw new Error(
          `static-generator: media ref ${ref}/${variant} unpublished during URL rewrite`,
        );
      }
      return `/${path}`;
    };
    for (const p of pages) {
      // issue #162 — shared enrichment (identical markup shape in the
      // editor preview; only the URL form differs).
      p.html = enrichResponsiveImages(p.html, this.#variantsByRef, {
        rewriteSrc: true,
        urlFor: urlForRef,
        formatFor: (ref, variant) =>
          (this.#variantsByRef.get(ref) ?? []).find((v) => v.variant === variant)?.format ?? "webp",
      });
      p.html = rewriteCatchAllMediaUrls(p.html, this.#published);
      p.html = injectLcpPreload(p.html, this.#variantsByRef, this.#published);
    }
  }

  /**
   * Publish the og:image of a page (it need not appear on any page, so the
   * HTML rewrite may not have published it): the best social-size variant
   * of the asset. Returns its build-relative path.
   */
  async publishOgImage(assetId: string): Promise<string> {
    const rows = (await this.#tx.execute(sql`
      SELECT ${VARIANT_COLUMNS}, ma.slug AS ref
      FROM media_variants mv
      JOIN media_assets ma ON ma.id = mv.asset_id
      WHERE mv.asset_id = ${assetId}::uuid
        AND ma.deleted_at IS NULL
      ORDER BY
        CASE mv.variant
          WHEN 'webp-1200' THEN 0
          WHEN 'webp-1600' THEN 1
          WHEN 'webp-800'  THEN 2
          WHEN 'orig'      THEN 3
          ELSE 4
        END
      LIMIT 1
    `)) as unknown as VariantRow[];
    const v = rows[0];
    if (!v) {
      throw new Error(
        `static-generator: og:image asset ${assetId} has no variants — deploy aborted (no-fallbacks)`,
      );
    }
    if (v.visibility === "reference") {
      // #531 — same rule as page images: references are never published.
      throw new Error(
        `static-generator: og:image asset ${v.slug} is a reference image and is never published. ` +
          "Next step: pick a library image for the page's og:image, or mark this one as a library " +
          'image (AI tool: set_media_visibility_many with visibility: "library").',
      );
    }
    const key = publishedKey(v.slug, v.variant);
    const known = this.#published.get(key);
    if (known !== undefined) return known;
    const { missingFiles } = await this.#publishVariants([{ ref: v.slug, isSlug: true, row: v }]);
    if (missingFiles.length > 0) {
      throw new Error(
        `static-generator: the stored file of og:image asset ${v.slug} (${v.variant}) is missing from ${this.#mediaRoot}. ` +
          "Next step: find it with list_missing_media and restore it (import_media_from_urls when it came from a URL, " +
          "or ask the operator to re-upload it), or pick another og:image for the page (set_page_seo_many).",
      );
    }
    const path = this.#published.get(key);
    if (path === undefined) throw new Error(`static-generator: og:image ${v.slug} not published`);
    return path;
  }

  /** Write `cdn_manifest.json` (always — an empty list when CDN copy is off). */
  async finish(): Promise<void> {
    await writeFile(
      join(this.#buildDir, "cdn_manifest.json"),
      JSON.stringify(
        {
          enabled: this.#settings.cdnEnabled,
          threshold: this.#settings.threshold,
          entries: [...this.#cdnManifest.values()],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  /** Resolve new refs in two batched reads (slugs, legacy ids) and publish their variants. */
  async #resolve(entries: [string, { isSlug: boolean }][]): Promise<void> {
    if (entries.length === 0) return;
    const slugs = entries.filter(([, e]) => e.isSlug).map(([r]) => r);
    const ids = entries.filter(([, e]) => !e.isSlug).map(([r]) => r);
    const rows: VariantRow[] = [];
    // Slug refs resolve via `media_assets.slug` (unique among live rows);
    // legacy id refs by asset id. One statement each, the refs bound as one
    // jsonb array (Bun SQL does not splat a JS array into a Postgres array).
    if (slugs.length > 0) {
      rows.push(
        ...((await this.#tx.execute(sql`
          SELECT ${VARIANT_COLUMNS}, ma.slug AS ref
          FROM media_assets ma
          JOIN media_variants mv ON mv.asset_id = ma.id
          WHERE ma.slug IN (SELECT jsonb_array_elements_text(${jsonb(slugs)}))
            AND ma.deleted_at IS NULL
        `)) as unknown as VariantRow[]),
      );
    }
    if (ids.length > 0) {
      rows.push(
        ...((await this.#tx.execute(sql`
          SELECT ${VARIANT_COLUMNS}, mv.asset_id::text AS ref
          FROM media_variants mv
          JOIN media_assets ma ON ma.id = mv.asset_id
          WHERE mv.asset_id IN (
              SELECT jsonb_array_elements_text(${jsonb(ids.filter((id) => MEDIA_UUID_RE.test(id)))})::uuid)
            AND ma.deleted_at IS NULL
        `)) as unknown as VariantRow[]),
      );
    }
    const fresh: ResolvedRef[] = entries.map(([ref, e]) => ({
      ref,
      isSlug: e.isSlug,
      variants: new Map(),
    }));
    const byRef = new Map(fresh.map((r) => [r.ref, r]));
    for (const row of rows) byRef.get(row.ref)?.variants.set(row.variant, row);
    for (const r of fresh) this.#resolved.set(r.ref, r);

    // #531 — a reference image guides generation/editing and never ships
    // on a page. Refuse loudly with the fix, rather than publishing it.
    const references = fresh
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

    // Every emitted variant of each referenced asset is published — the
    // srcset enrichment needs the full breakpoint ladder even when the
    // HTML only names orig.
    const { missingFiles } = await this.#publishVariants(
      fresh.flatMap((r) =>
        [...r.variants.values()].map((row) => ({ ref: r.ref, isSlug: r.isSlug, row })),
      ),
    );
    if (missingFiles.length > 0) {
      throw new Error(missingMediaFilesError(missingFiles, this.#mediaRoot));
    }
    for (const r of fresh) {
      this.#variantsByRef.set(
        r.ref,
        [...r.variants.values()].map((row) => ({
          variant: row.variant,
          format: row.format,
          width: row.width,
        })),
      );
    }
  }

  /**
   * Name each variant by its stored digest and make it part of the build —
   * a reference, or a hard link for {@link MediaDelivery} `link`. Returns
   * the assets whose stored file is gone, grouped per asset, so one failed
   * Stage names all of them.
   */
  async #publishVariants(
    items: readonly { ref: string; isSlug: boolean; row: VariantRow }[],
  ): Promise<{ missingFiles: { row: VariantRow; variants: string[] }[] }> {
    const undigested = items.filter((i) => i.row.content_sha256 === null);
    if (undigested.length > 0) {
      const named = [...new Set(undigested.map((i) => `${i.row.slug}/${i.row.variant}`))];
      throw new Error(
        `static-generator: ${named.length} media file(s) have no stored digests: ${named.slice(0, 20).join(", ")}${named.length > 20 ? ", …" : ""}. ` +
          "Stage digests them before every build (media.rebuild_digests); this build was started without that step. " +
          'Next step: Stage again, or run media.rebuild_digests (AI tool: rebuild_media_digests, scope "missing") and build again.',
      );
    }
    const missing = new Map<string, { row: VariantRow; variants: string[] }>();
    await runBatched([...items], FS_PARALLELISM, async ({ ref, isSlug, row }) => {
      const contentSha256 = row.content_sha256 as string;
      const relPath = mediaAssetRelPath({
        ref,
        isSlug,
        variant: row.variant,
        format: row.format,
        contentHash: mediaContentHash(contentSha256),
      });
      const source = this.#sourcePath(row.storage_key);
      const present = await this.#deliver(source, relPath);
      if (!present) {
        const entry = missing.get(row.asset_id) ?? { row, variants: [] };
        entry.variants.push(row.variant);
        missing.set(row.asset_id, entry);
        return;
      }
      this.#published.set(publishedKey(ref, row.variant), relPath);
      if (!this.#assets.has(relPath)) {
        this.#assets.set(relPath, {
          path: relPath,
          contentSha256,
          size: Number(row.size_bytes),
          gzipSha256: row.gzip_sha256 as string,
          gzipSize: Number(row.gzip_size),
          digestProfile: row.digest_profile as string,
          source: { kind: "media", storageKey: row.storage_key },
        });
      }
      if (this.#settings.cdnEnabled && row.usage_count >= this.#settings.threshold) {
        this.#cdnManifest.set(relPath, {
          assetId: row.asset_id,
          variant: row.variant,
          format: row.format,
          outputPath: relPath,
          bytes: Number(row.size_bytes),
          usageCount: row.usage_count,
        });
      }
    });
    return { missingFiles: [...missing.values()] };
  }

  /** The stored file of a storage key, refusing a key that escapes the store. */
  #sourcePath(storageKey: string): string {
    const source = resolve(this.#mediaRoot, storageKey);
    if (!source.startsWith(`${this.#mediaRoot}${sep}`)) {
      throw new Error(`static-generator: storage key escapes mediaRoot: ${storageKey}`);
    }
    return source;
  }

  /**
   * Make the stored file part of the build without reading it: a `stat`
   * (reference), or a hard link into the build (link; across filesystems
   * the kernel copies it). False when the stored file is gone.
   */
  async #deliver(source: string, relPath: string): Promise<boolean> {
    if (this.#delivery === "reference") {
      try {
        return (await stat(source)).isFile();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw e;
      }
    }
    const target = join(this.#buildDir, relPath);
    await mkdir(dirname(target), { recursive: true });
    try {
      await link(source, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (code === "EEXIST") return true;
      // The media store on another filesystem (a separate volume): the
      // kernel copies the file; the process still never holds its bytes.
      if (code === "EXDEV" || code === "EPERM") {
        try {
          await copyFile(source, target);
        } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw copyError;
        }
        return true;
      }
      throw e;
    }
    return true;
  }
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

/** Key of the published-path map: the ref as written in the HTML + the variant. */
function publishedKey(ref: string, variant: string): string {
  return `${ref}|${variant}`;
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
