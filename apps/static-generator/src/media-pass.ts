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
 * `media_variants.content_sha256` (migration 0452), and each published file
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
 * #1600 / #1604 — except on a Stage: a full staging build never stops on
 * the site's content, so there (`unresolved: "report"`) a reference no
 * asset or variant answers keeps its `/_caelo/media/...` URL, which is
 * what the editor preview shows for it too (its media route answers 404),
 * and {@link MediaPass.rewritePages} returns it for the build to record as
 * a render failure; Publish live refuses such a build. Every other build
 * refuses it with a {@link BuildRefusal}: it is the site's content, not a
 * Caelo fault, and the message names what to change.
 *
 * #1719 — the same holds for the pass's other content refusals: a page that
 * shows a reference image (#531, never published: its URL stays as the
 * preview has it) and a share image ({@link MediaPass.publishOgImage}) that
 * was deleted, has no image file or is a reference image (the page ships
 * without `og:image`). What no content edit repairs still stops every build
 * with an error: a stored file missing from the media store, a storage key
 * outside it, a row the Stage should have digested.
 *
 * CDN copy: if `site_defaults.media_cdn_copy_enabled` is on, the pass
 * also writes `cdn_manifest.json` listing every (asset, variant) used
 * at least `media_cdn_usage_threshold` times. P7 emits the manifest
 * only — the actual upload + URL rewrite to a CDN domain is the P15
 * cloud adapter's job.
 */

import { copyFile, link, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type TransactionRunner, textArray } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  enrichResponsiveImages,
  extractMediaRefs,
  type ImageVariantInfo,
  type MediaRef,
  mediaFailureMarker,
  mediaReferenceMarker,
  mediaUrlForRef,
  parseVariantWidth,
  runBatched,
  SHARE_IMAGE_ORIG_FORMATS,
  SHARE_IMAGE_ORIG_MAX_BYTES,
  variantFamily,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { AssetReference } from "./asset-references.js";
import { BuildRefusal } from "./build-refusal.js";
import { mediaAssetRelPath, mediaContentHash } from "./media-asset-path.js";
import type { RenderFailure } from "./nested-modules-pass.js";

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

/**
 * What a reference no asset or variant answers does to the build:
 * `refuse` stops it ({@link BuildRefusal}); `report` (a full staging
 * build, #1604) ships it as written and returns it from
 * {@link MediaPass.rewritePages}.
 */
export type UnresolvedMediaPolicy = "refuse" | "report";

/** A media reference of one page the build could not publish (#1600, #1719). */
export interface UnresolvedMediaRef<P> {
  readonly page: P;
  /** The asset as the HTML names it: its slug, or a legacy id. */
  readonly ref: string;
  readonly isSlug: boolean;
  /** The variant the HTML names (`orig` for the flat slug form). */
  readonly variant: string;
  /**
   * `missing`: no live asset answers `ref`; `variant-missing`: the asset
   * lacks the variant; `reference`: a reference image (#531), never published.
   */
  readonly problem: "missing" | "variant-missing" | "reference";
  /** Every variant the asset has, sorted; null unless `problem` is `variant-missing`. */
  readonly variants: readonly string[] | null;
}

/**
 * What {@link MediaPass.publishOgImage} did with a share image: published
 * it, or (on a Stage, #1719) found the asset `missing` (deleted, or no image
 * file) or a `reference` image, which is never published.
 */
export type OgImageOutcome =
  | { readonly kind: "published"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "reference" };

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
  /** A reference image (#531): resolved, never published. */
  reference: boolean;
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
  readonly #unresolved: UnresolvedMediaPolicy;
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
    unresolved: UnresolvedMediaPolicy;
  }) {
    this.#tx = args.tx;
    this.#buildDir = args.buildDir;
    this.#mediaRoot = resolve(args.mediaRoot);
    this.#settings = args.settings;
    this.#delivery = args.delivery;
    this.#unresolved = args.unresolved;
  }

  /** The files the build references so far, by published path. */
  assets(): AssetReference[] {
    // Sorted: the files are found concurrently, and the build's output must
    // not depend on which stat answered first.
    return [...this.#assets.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  /**
   * Rewrite one batch of pages in place: resolve the refs no earlier batch
   * had, publish their variants, then swap every `/_caelo/media/...` URL
   * for its `/_assets/...` path (with srcset, dimensions and the LCP
   * preload, exactly as the editor preview enriches it).
   *
   * @returns the references no asset or variant answers, per page — always
   *   empty under `unresolved: "refuse"`, which throws on the first batch
   *   that has one.
   */
  async rewritePages<P extends { html: string; pageSlug: string }>(
    pages: P[],
  ): Promise<UnresolvedMediaRef<P>[]> {
    // 1. Every (ref, variant) the batch references. `ref` is a slug (current
    //    embeds) or a legacy uuid id; the two never collide since the ref
    //    string IS the map key.
    const pageRefs: MediaRef[][] = pages.map((p) => extractMediaRefs(p.html));
    const refs = new Map<string, { isSlug: boolean; variants: Set<string> }>();
    for (const r of pageRefs.flat()) {
      const entry = refs.get(r.ref) ?? { isSlug: r.isSlug, variants: new Set<string>() };
      entry.variants.add(r.variant);
      refs.set(r.ref, entry);
    }
    if (refs.size === 0) return [];
    await this.#resolve([...refs].filter(([ref]) => !this.#resolved.has(ref)));

    // 2. Verify every referenced (ref, variant) is resolvable. Per the
    //    no-fallbacks rule this fails the deploy loudly when a module
    //    references a deleted asset or an unemitted variant — except on a
    //    Stage, which ships the reference as written and reports it (#1604).
    //    A reference image (#1719) is reported the same way: on a Stage
    //    only, since every other build refused it while resolving.
    const unresolvedKeys = new Set<string>();
    for (const [ref, info] of refs) {
      const res = this.#resolved.get(ref);
      for (const v of info.variants) {
        if (res?.reference || !res?.variants.has(v)) unresolvedKeys.add(publishedKey(ref, v));
      }
    }
    const variantsOf = (ref: string): readonly string[] | null => {
      const res = this.#resolved.get(ref);
      return res === undefined || res.variants.size === 0 ? null : [...res.variants.keys()].sort();
    };
    const problemOf = (ref: string): UnresolvedMediaRef<P>["problem"] =>
      this.#resolved.get(ref)?.reference
        ? "reference"
        : variantsOf(ref) === null
          ? "missing"
          : "variant-missing";
    if (unresolvedKeys.size > 0 && this.#unresolved === "refuse") {
      const missing = [...refs].flatMap(([ref, info]) =>
        [...info.variants]
          .filter((v) => unresolvedKeys.has(publishedKey(ref, v)))
          .map((v) => {
            const has = variantsOf(ref);
            return `${ref}/${v} (${has === null ? "no such image" : `has: ${has.join(", ")}`})`;
          }),
      );
      // run #10 D4 — AI-actionable failure surface (CLAUDE.md §11): name
      // the recovery op, and the by-design case where recovery means
      // re-pointing the HTML instead (source narrower than the
      // breakpoint / animated GIF — the pipeline never upscales).
      throw new BuildRefusal(
        `static-generator: media references unresolved (asset/variant pairs missing): ${missing.join(", ")}. ` +
          "Next step: point each at a size the image has (find_media's url always names one), or at another " +
          "image — in module HTML via update_modules_many (list_media_usages finds the modules), in a content " +
          "value via set_content_instance_values_many. A size the pipeline should have made can be re-made with " +
          "regenerate_media_variants; it never makes one wider than the source, and none for an animated GIF or a " +
          "non-raster file. A Stage ships such a reference and reports it instead of stopping; Publish live " +
          "refuses it until it is repaired.",
      );
    }
    const unresolved: UnresolvedMediaRef<P>[] = [];
    pages.forEach((page, i) => {
      for (const r of pageRefs[i] ?? []) {
        if (!unresolvedKeys.has(publishedKey(r.ref, r.variant))) continue;
        const problem = problemOf(r.ref);
        unresolved.push({
          page,
          ...r,
          problem,
          variants: problem === "variant-missing" ? variantsOf(r.ref) : null,
        });
      }
    });

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
      const key = publishedKey(ref, variant);
      const path = this.#published.get(key);
      if (path === undefined) {
        // A reported reference ships as written (#1604).
        if (unresolvedKeys.has(key)) return mediaUrlForRef(ref, variant);
        // No-fallbacks: every other img media ref was extracted, resolved
        // and published above.
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
    return unresolved;
  }

  /**
   * Publish the og:image of a page (it need not appear on any page, so the
   * HTML rewrite may not have published it): the original when every
   * social platform shows it (JPEG or PNG up to 5 MB, #1757:
   * `SHARE_IMAGE_ORIG_FORMATS`), else the best social-size variant of the
   * asset, at its build-relative path.
   *
   * #1719 — an asset that was deleted, has no image file or is a reference
   * image is the site's content: a Stage (`unresolved: "report"`) gets the
   * outcome back to ship the page without `og:image` and report it; every
   * other build refuses it ({@link BuildRefusal}). A stored file missing
   * from the media store stops every build.
   */
  async publishOgImage(assetId: string): Promise<OgImageOutcome> {
    const rows = (await this.#tx.execute(sql`
      SELECT ${VARIANT_COLUMNS}, ma.slug AS ref
      FROM media_variants mv
      JOIN media_assets ma ON ma.id = mv.asset_id
      WHERE mv.asset_id = ${assetId}::uuid
        AND ma.deleted_at IS NULL
      ORDER BY
        CASE
          WHEN mv.variant = 'orig' AND mv.format = ANY(${textArray([...SHARE_IMAGE_ORIG_FORMATS])})
            AND mv.size_bytes <= ${SHARE_IMAGE_ORIG_MAX_BYTES} THEN 0
          WHEN mv.variant = 'webp-1200' THEN 1
          WHEN mv.variant = 'webp-1600' THEN 2
          WHEN mv.variant = 'webp-800'  THEN 3
          WHEN mv.variant = 'orig'      THEN 4
          ELSE 5
        END
      LIMIT 1
    `)) as unknown as VariantRow[];
    const v = rows[0];
    if (!v) {
      if (this.#unresolved === "report") return { kind: "missing" };
      throw new BuildRefusal(
        `static-generator: og:image asset ${assetId} has no variants or was deleted — deploy aborted (no-fallbacks). Next step: repair it with regenerate_media_variants, or bind another image (set_page_seo_many for a page's own image, set_theme_asset slot socialShare for the site default), then Stage again.`,
      );
    }
    if (v.visibility === "reference") {
      // #531 — same rule as page images: references are never published.
      if (this.#unresolved === "report") return { kind: "reference" };
      throw new BuildRefusal(
        `static-generator: og:image asset ${v.slug} is a reference image and is never published. ` +
          "Next step: pick a library image for the page's og:image, or mark this one as a library " +
          'image (AI tool: set_media_visibility_many with visibility: "library").',
      );
    }
    const key = publishedKey(v.slug, v.variant);
    const known = this.#published.get(key);
    if (known !== undefined) return { kind: "published", path: known };
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
    return { kind: "published", path };
  }

  /**
   * Write `cdn_manifest.json` (always — an empty list when CDN copy is off)
   * through `write` (the build's output; default: the build directory).
   */
  async finish(
    write: (relPath: string, content: string) => Promise<void> = (relPath, content) =>
      writeFile(join(this.#buildDir, relPath), content, "utf8"),
  ): Promise<void> {
    await write(
      "cdn_manifest.json",
      JSON.stringify(
        {
          enabled: this.#settings.cdnEnabled,
          threshold: this.#settings.threshold,
          // Sorted for the same reason as assets(): the file is part of the
          // parity manifest, so its bytes must not depend on I/O order.
          entries: [...this.#cdnManifest.values()].sort((a, b) =>
            a.outputPath < b.outputPath ? -1 : a.outputPath > b.outputPath ? 1 : 0,
          ),
        },
        null,
        2,
      ),
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
      reference: false,
    }));
    const byRef = new Map(fresh.map((r) => [r.ref, r]));
    for (const row of rows) byRef.get(row.ref)?.variants.set(row.variant, row);
    for (const r of fresh) {
      r.reference = [...r.variants.values()].some((v) => v.visibility === "reference");
      this.#resolved.set(r.ref, r);
    }

    // #531 — a reference image guides generation/editing and never ships
    // on a page. Every build but a Stage refuses it with the fix; a Stage
    // (#1719) keeps its URL as written, publishes none of its files and
    // reports it (rewritePages).
    const references = fresh.filter((r) => r.reference).map((r) => r.ref);
    if (references.length > 0 && this.#unresolved === "refuse") {
      throw new BuildRefusal(
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
    const published = fresh.filter((r) => !r.reference);
    const { missingFiles } = await this.#publishVariants(
      published.flatMap((r) =>
        [...r.variants.values()].map((row) => ({ ref: r.ref, isSlug: r.isSlug, row })),
      ),
    );
    if (missingFiles.length > 0) {
      throw new Error(missingMediaFilesError(missingFiles, this.#mediaRoot));
    }
    for (const r of published) {
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
    const missing = new Map<string, { row: VariantRow; variants: string[] }>();
    const noteMissing = (row: VariantRow): void => {
      const entry = missing.get(row.asset_id) ?? { row, variants: [] };
      entry.variants.push(row.variant);
      missing.set(row.asset_id, entry);
    };
    // A row without digests whose file is gone (the backfill could not
    // digest it) is a missing file: say that, with the way to restore it,
    // not "run the backfill", which cannot help.
    const undigested: (typeof items)[number][] = [];
    await runBatched(
      items.filter((i) => i.row.content_sha256 === null),
      FS_PARALLELISM,
      async (item) => {
        if (await isFile(this.#sourcePath(item.row.storage_key))) undigested.push(item);
        else noteMissing(item.row);
      },
    );
    if (missing.size > 0) return { missingFiles: [...missing.values()] };
    if (undigested.length > 0) {
      const named = [...new Set(undigested.map((i) => `${i.row.slug}/${i.row.variant}`))];
      throw new Error(
        `static-generator: ${named.length} media file(s) have no stored digests: ${named.slice(0, 20).join(", ")}${named.length > 20 ? ", …" : ""}. ` +
          "Stage digests them before every build (media.rebuild_digests); this build was started without that step. " +
          "Next step: Stage again — every Stage digests such rows before the build.",
      );
    }
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
        noteMissing(row);
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
    if (this.#delivery === "reference") return isFile(source);
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

/** Whether `path` is a file, without reading it; false when it does not exist. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
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

/**
 * #1600 — the render failure a Stage records for a media reference it could
 * not publish. The media pass reads the composed page, which no longer says
 * which module wrote the reference, so the place is the page and the
 * reference itself names what to change.
 *
 * @param pagePath the page's path; the output path stands in for a page the
 *   build's page list does not name.
 */
export function mediaRenderFailure(
  u: UnresolvedMediaRef<{
    readonly pageId: string;
    readonly pageSlug: string;
    readonly pageTitle: string;
    readonly relPath: string;
  }>,
  pagePath: string | undefined,
): RenderFailure {
  const url = mediaUrlForRef(u.ref, u.variant);
  const at = `page "${u.page.pageSlug}": image ${url}`;
  const { reason, line } =
    u.problem === "reference"
      ? {
          reason: mediaReferenceMarker({ ref: u.ref, variant: u.variant }),
          line: `${at} is a reference image, which is never published`,
        }
      : u.problem === "missing"
        ? {
            reason: mediaFailureMarker({ ref: u.ref, variant: u.variant, variants: null }),
            line: `${at} names no image in the media library`,
          }
        : {
            reason: mediaFailureMarker({ ref: u.ref, variant: u.variant, variants: u.variants }),
            line: `${at} names size "${u.variant}", which this image does not have (it has: ${(u.variants ?? []).join(", ")})`,
          };
  return {
    pageId: u.page.pageId,
    pageTitle: u.page.pageTitle,
    pagePath: pagePath ?? `/${u.page.relPath}`,
    blockName: null,
    moduleSlug: null,
    field: null,
    reason,
    target: null,
    line,
  };
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
 * Inject `<link rel="preload" as="image" fetchpriority="high">` for the
 * LCP candidate — the first image in the page. The preload starts the
 * image's request, so it carries the priority: without
 * `fetchpriority="high"` the request starts at the preload's default
 * priority and Lighthouse's lcp-discovery-insight fails even when the
 * `<img>` itself says `fetchpriority="high"` (#1606).
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
  const tag = `<link rel="preload" as="image" fetchpriority="high" imagesrcset="${imagesrcset}" imagesizes="${imagesizes}" />`;
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
