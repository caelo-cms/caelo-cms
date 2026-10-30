// SPDX-License-Identifier: MPL-2.0
import { fontReader } from "@caelo-cms/font-service";

/**
 * Static generator entry point. Takes a transaction handle on `cms_admin`
 * plus a `DeployTarget` and emits one HTML file per published page into
 * a fresh build directory, then mirrors the build into `current/` so
 * the serving layer (Caddy / nginx) sees the latest content.
 *
 * Layout per env:
 *   output/<env>/builds/<runId>/  ← fresh build, immutable once done
 *   output/<env>/builds/<runId>/index.html / robots.txt / ...
 *   output/<env>/current/         ← regular dir mirroring the latest build
 *
 * Caddy bind-mounts `output/<env>` and serves from `/srv/current`. We
 * sync the build into `current/` in place rather than swapping a symlink
 * because Docker Desktop / VirtioFS bind mounts on macOS don't follow
 * symlinks reliably across the host/container boundary. The
 * `builds/<runId>/` archive stays immutable for content-addressed
 * rollback (`deploy.rollback` re-syncs an older build into `current/`).
 *
 * Composition reuses `composePageWithLayout` from shared, with nested
 * modules rendered by the same recursive renderer as the editor preview,
 * so preview and production produce the same HTML.
 *
 * #1271 — memory does not grow with the site. Pages are composed,
 * rewritten and written {@link PAGE_BATCH} at a time (their placements,
 * variants and nested modules loaded per batch, page-batch.ts); what a
 * later step needs from every page is a small record per page. Media and
 * fonts are never read: the build references them by their stored digests
 * (asset-references.ts) and the publisher delivers them — self-hosted
 * hard-links them into the build (`mediaDelivery: "link"`).
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type BuildPluginServices, injectPluginAssets } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  ComposeError,
  type ComposeFonts,
  type ComposeTheme,
  type ComposeThemeAsset,
  collectListModuleRefs,
  composePageWithLayout,
  createListRenderContext,
  FAVICON_VARIANT,
  fontUnresolvableMarker,
  isRasterImageMime,
  LIST_QUERY_MAX_LIMIT,
  type ListRenderDeps,
  linkMarkersOf,
  mergeListRenderDeps,
  type PaginationRequest,
  PhaseTimer,
  type PhaseTiming,
  pagedPath,
  redirectTargetIssue,
  renderEveryPage,
  runBatched,
  type ThemeDocument,
  themeFaviconRendition,
  trimSlashes,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import {
  ASSET_REFERENCES_FILE,
  BUILD_INTERNAL_FILES,
  serializeAssetReferences,
} from "./asset-references.js";
import type { VariantComposeModule } from "./content-variants-pass.js";
import { publishFontFiles } from "./font-assets.js";
import { loadSiteFontUsage } from "./font-usage-sources.js";
import { defaultFontsCacheDir, resolveThemeFonts } from "./fonts-resolver.js";
import { loadBuildLinkIndex } from "./link-index.js";
import {
  type BuildChange,
  incrementalPageIds,
  isIncremental,
  loadBuildListRenderData,
  readTargetRenderDeps,
  writeRenderDeps,
} from "./list-data.js";
import { type MediaDelivery, MediaPass, readMediaSettings } from "./media-pass.js";
import { MinifyCache, minifyPageAssets } from "./minify-pass.js";
import {
  assertNoRenderFailures,
  type RenderFailure,
  renderFailuresOf,
} from "./nested-modules-pass.js";
import {
  NOT_FOUND_PAGE_FILE,
  notFoundPageBuildError,
  readNotFoundPageId,
} from "./not-found-page.js";
import {
  type LayoutModule,
  loadBatch,
  type PageRow,
  parseModuleFields,
  resolveDeferredModules,
} from "./page-batch.js";
import {
  assertPaginationRenderable,
  followUpCollisionError,
  type TruncatedListReport,
} from "./pagination-pass.js";
import { hostNormaliser, ParityRecorder } from "./parity-digest.js";
import { BakeStore, type BakeTarget, runPluginRenderPass } from "./plugin-pass.js";
import { rewritePreviewFontUrls } from "./preview-font-urls.js";
import { writeRedirectFiles } from "./redirects-pass.js";
import {
  buildRobotsTxtWithSitemap,
  prepareSeoPass,
  readSeoSettings,
  requireSiteLanguage,
} from "./seo-pass.js";
import { syncContents } from "./sync-contents.js";

/** Page files written at once: bounded so a large site cannot exhaust file descriptors. */
const WRITE_PARALLELISM = 32;

/**
 * #1271 — pages composed, rewritten and written together. Bounds the HTML
 * the build holds (a batch's pages) while keeping the per-batch reads and
 * plugin calls few: 200 pages are a few MB of HTML and one round of
 * statements and plugin calls each.
 */
export const PAGE_BATCH = 200;

export interface DeployTarget {
  readonly id: string;
  readonly name: string;
  readonly env: "dev" | "staging" | "production";
  readonly outDir: string;
  readonly baseUrl: string;
  readonly robotsDefault: "index" | "noindex";
  /**
   * v0.2.85 — per-target page emission style.
   *
   * 'directory'    → emit `<slug>/index.html`. The default.
   *                  GCS bucket-website mode serves /<slug>/ →
   *                  <slug>/index.html. /foo (no trailing slash)
   *                  301s to /foo/index.html, exposing `.html`
   *                  in the URL bar.
   * 'no-extension' → emit `<slug>` (no extension) with explicit
   *                  Content-Type: text/html. /foo → 200 page;
   *                  /foo/ and /foo/index.html don't exist → 404.
   *                  Canonical URLs become /foo (no trailing slash).
   *                  No redirects needed because there's nothing
   *                  to redirect away from.
   *
   * Optional with a 'directory' default so callers that haven't
   * been updated (tests, older subprocess invocations) keep the
   * pre-v0.2.85 behavior.
   */
  readonly pageUrlStyle?: "directory" | "no-extension";
}

export interface GenerateResult {
  readonly pageCount: number;
  readonly fileCount: number;
  readonly durationMs: number;
  /**
   * Where `durationMs` went, pass by pass, in build order. A Stage
   * reports them with its own steps (deploy_runs.phase_timings).
   */
  readonly phases: readonly PhaseTiming[];
  /** Absolute path to the build dir under builds/<runId>. */
  readonly buildDir: string;
  /** #1271 — the generator process's peak resident memory over the build, in MiB. */
  readonly peakRssMb: number;
  /**
   * Epic #724 — internal links whose target page exists but is not
   * published, so this build does not contain it. Per the #724 decision
   * a warning at Stage; the blocking check for Publish live / promote
   * consumes the same list (rollout F). Missing targets never get here:
   * they fail the build in the render gate.
   */
  readonly unpublishedLinkTargets: readonly UnpublishedLinkTarget[];
  /**
   * #1257 — page lists cut at the query cap (50): the overview shows 50
   * of more matches. A warning at Stage; paginating the list fixes it.
   */
  readonly truncatedLists: readonly TruncatedListReport[];
}

/** One page linking to a page this build does not ship. */
export interface UnpublishedLinkTarget {
  /** The page carrying the link. */
  readonly pageSlug: string;
  readonly pagePath: string;
  /** The page the link renders to (after the page-variant mapping) and its URL. */
  readonly targetPageId: string;
  readonly targetUrl: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidArrayLiteral(ids: ReadonlyArray<string>): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`uuidArrayLiteral: not a UUID: ${id}`);
  }
  return `ARRAY[${ids.map((id) => `'${id}'`).join(",")}]`;
}

/** Optional progress callback so the parent process can show pagesDone/total. */
export type ProgressCallback = (progress: { pagesDone: number; pagesTotal: number }) => void;

/**
 * Maps a COMPOSED public path (`pages.current_path`, #390) to its
 * emitted file. "/" becomes `index.html`; "/de/pricing" becomes
 * `de/pricing/index.html` (directory style) or `de/pricing`
 * (no-extension) so static hosts serve clean URLs. Home stays at
 * `index.html` regardless of style — the bucket root must serve
 * something for `/`, and the page's canonical points at `/` so search
 * engines consolidate either way.
 */
export function pageOutputPath(
  currentPath: string,
  pageUrlStyle: "directory" | "no-extension" = "directory",
): string {
  const trimmed = trimSlashes(currentPath);
  if (trimmed.length === 0) return "index.html";
  for (const seg of trimmed.split("/")) {
    if (seg.length === 0 || seg === "." || seg === "..") {
      throw new Error(`static-generator: invalid page path "${currentPath}"`);
    }
  }
  return pageUrlStyle === "no-extension" ? trimmed : `${trimmed}/index.html`;
}

/**
 * #802 — the file a built page is written to: `404.html` for the
 * designated 404 page (whatever the URL style; see not-found-page.ts),
 * its composed path ({@link pageOutputPath}) otherwise.
 */
export function builtPageOutputPath(
  page: { readonly pageId: string; readonly currentPath: string },
  notFoundPageId: string | null,
  pageUrlStyle: "directory" | "no-extension" = "directory",
): string {
  if (notFoundPageId !== null && page.pageId === notFoundPageId) return NOT_FOUND_PAGE_FILE;
  return pageOutputPath(page.currentPath, pageUrlStyle);
}

/**
 * Migration run #9 R10 (issue #262) — a full-site staging/production
 * build that selects ZERO pages is not a servable site; every URL on
 * the target would 404. Run #9 hit exactly this: a migration creates
 * pages as drafts, staging filters to `status='published'`, and the
 * operator's first Stage "succeeded" with page_count=0 — success toast,
 * empty site. Per CLAUDE.md §2 (no fallbacks pre-1.0) this must fail
 * loudly with the next step, not ship an empty build.
 *
 * Scope: full builds on non-dev targets only. `dev` is an unfiltered
 * debugging surface, and an *incremental* build (`changedPageIds`)
 * matching zero published pages is a routine no-op — e.g. a rebuild of
 * pages that are all still drafts — not an unservable site.
 *
 * @returns the error message to throw, or null when the build may
 *   proceed. Pure so the guard is unit-testable without a DB.
 */
export function zeroPageBuildError(args: {
  pageCount: number;
  env: DeployTarget["env"];
  incremental: boolean;
}): string | null {
  if (args.pageCount > 0 || args.env === "dev" || args.incremental) return null;
  return (
    `static-generator: 0 published pages for env='${args.env}' — nothing to serve. ` +
    "Pages with status='draft' are live-edit-only and never ship to staging or production. " +
    "Publish the pages first (AI: `set_pages_status_many`; UI: the bulk publish action on /content/pages or the /edit status toggle), then re-run the deploy."
  );
}

/**
 * issue #302 (run #14 finding) — a full staging/production build where NO
 * page lands at the bucket root (`index.html`) ships a site whose `/`
 * 404s. The migration flow hit exactly this: the rebuilt homepage carried
 * a source-derived slug, `pageOutputPath` only roots the slugs "", "home"
 * and "index", and nothing failed — the operator found the 404 by hand.
 * Per CLAUDE.md §2 (no fallbacks pre-1.0) this fails loudly with the fix
 * spelled out instead of shipping an unservable root.
 *
 * Scope mirrors `zeroPageBuildError`: full builds on non-dev targets.
 *
 * @returns the error message to throw, or null when the build may proceed.
 *   Pure so the guard is unit-testable without a DB.
 */
export function missingRootPageError(args: {
  /** Every emitted page path (relative, e.g. "index.html", "about/index.html"). */
  outputPaths: readonly string[];
  /** Every built page's slug — any of them could claim the root. */
  rootEligibleSlugs: readonly string[];
  env: DeployTarget["env"];
  incremental: boolean;
}): string | null {
  if (args.env === "dev" || args.incremental) return null;
  if (args.outputPaths.includes("index.html")) return null;
  if (args.rootEligibleSlugs.length === 0) return null;
  const sample = args.rootEligibleSlugs.slice(0, 10).join(", ");
  return (
    `static-generator: no page serves the site root '/' for env='${args.env}' — ` +
    `none of the ${args.outputPaths.length} published page(s) maps to index.html, so visitors hitting the bare domain get a 404. ` +
    "Designate the intended homepage and make sure it is published (AI: `set_home_page`, then `set_pages_status_many` if it is a draft; UI: the page's settings), then re-run the deploy. " +
    "Do not rename another page's slug to 'home' — that moves its URL. " +
    `Root-eligible slugs in this build: ${sample}${args.rootEligibleSlugs.length > 10 ? ", …" : ""}`
  );
}

/**
 * #1257 — a page file that other pages would need as a directory. In the
 * `no-extension` style a page IS a file (`guides`), so nothing can be
 * served below its URL: neither a nested page (`guides/intro`) nor a
 * paginated overview's follow-up page (`guides/page/2`). Writing both
 * fails with EISDIR halfway through the write pass; this names the pages
 * and the fix before any file is written.
 *
 * @returns the error message to throw, or null. Pure for tests.
 */
export function outputPathCollisionError(relPaths: readonly string[]): string | null {
  const registry = new OutputPathRegistry();
  for (const p of relPaths) registry.add(p);
  return registry.collisionError();
}

/**
 * #1271 — the output paths of a build, checked as they are added (page 1
 * paths up front, a paginated overview's follow-up paths per batch), so a
 * file that other pages need as a folder is named before anything is
 * written below it — without holding every path twice.
 */
export class OutputPathRegistry {
  readonly #files = new Set<string>();
  readonly #dirs = new Set<string>();
  readonly #hits = new Set<string>();

  /** Add one build-relative output path. */
  add(relPath: string): void {
    const segs = relPath.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      const dir = segs.slice(0, i).join("/");
      if (this.#files.has(dir)) this.#hits.add(`${dir} (needed as a folder by ${relPath})`);
      this.#dirs.add(dir);
    }
    if (this.#dirs.has(relPath)) {
      // An earlier path sits below this one: name each such path once.
      this.#hits.add(`${relPath} (needed as a folder by another page)`);
    }
    this.#files.add(relPath);
  }

  /** The refusal for the collisions found so far, or null. */
  collisionError(): string | null {
    if (this.#hits.size === 0) return null;
    const listed = [...this.#hits].slice(0, 10).join(", ");
    return (
      `static-generator: ${this.#hits.size} page(s) are served as files but other pages sit below their URL: ${listed}. ` +
      "In the no-extension URL style a page cannot have nested pages or follow-up pages of a paginated list (<path>/page/<n>). " +
      "Next step: switch the deploy target to the directory URL style (Ops → Deploy), or move the nested pages / remove paginate from that page's list."
    );
  }

  /** Throw {@link collisionError} when there is one. */
  assertNone(): void {
    const e = this.collisionError();
    if (e !== null) throw new Error(e);
  }
}

/**
 * Renders the robots.txt body. `index` mode allows everything; `noindex`
 * blocks all crawlers — required for staging per CMS_REQUIREMENTS §6.
 */
export function buildRobotsTxt(robots: "index" | "noindex"): string {
  if (robots === "noindex") {
    return "User-agent: *\nDisallow: /\n";
  }
  return "User-agent: *\nAllow: /\n";
}

/**
 * True when a build's routing-manifest.json says (or, by omission,
 * implies) that its HTML carries the target env's `noindex` robots meta.
 * Builds from before the env-independent SEO pass baked staging's
 * `noindex` into every page and omit the `envNoindexInHtml: false`
 * flag; promoting one of those to an indexable target would ship
 * `noindex` on every production page, so promote refuses them
 * (see {@link envNoindexBuildError}).
 */
export function manifestBakesEnvNoindex(manifest: unknown): boolean {
  if (typeof manifest !== "object" || manifest === null) return true;
  return (manifest as { envNoindexInHtml?: unknown }).envNoindexInHtml !== false;
}

/**
 * The operator/AI-facing refusal every publisher's promote throws for a
 * source build whose pages carry the source env's `noindex` meta.
 */
export function envNoindexBuildError(sourceBuildId: string): Error {
  return new Error(
    `staged build ${sourceBuildId} was rendered with the staging target's noindex baked into every page, ` +
      "so publishing it would drop the live site out of search engines. " +
      "Next step: run Stage again (deploy.trigger on the staging target) and then Publish live — " +
      "a fresh staging build carries no environment-level noindex.",
  );
}

/**
 * #605 — throw when any page still carries a section marker of a plugin
 * data list (`{{#name}}`, `{{^name}}`, `{{/name}}`). Exported for tests.
 *
 * @param listNames every data-list name a plugin declared, running or not.
 */
export function assertNoPluginMarkers(
  pages: ReadonlyArray<{ readonly pageSlug: string; readonly html: string }>,
  listNames: ReadonlyArray<string>,
): void {
  if (listNames.length === 0) return;
  const names = new Set(listNames);
  const found: string[] = [];
  for (const page of pages) {
    const hits = new Set<string>();
    for (const m of page.html.matchAll(/\{\{\s*[#^/]\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
      if (m[1] && names.has(m[1])) hits.add(m[1]);
    }
    if (hits.size > 0) found.push(`page "${page.pageSlug}": ${[...hits].sort().join(", ")}`);
  }
  if (found.length > 0) {
    throw new Error(
      `static-generator: ${found.length} page(s) would ship raw plugin data-list markers — ${found.join("; ")}. ` +
        "The plugin that offers the list is not running for this build. Activate it again at /settings/plugins, or remove the module that iterates the list, then publish again.",
    );
  }
}

export async function generateSite(args: {
  tx: TransactionRunner;
  target: DeployTarget;
  /** Stable id (deploy_runs.id) used as the build directory name. */
  runId: string;
  /** Optional repo root so out_dir resolves against it; defaults to cwd. */
  repoRoot?: string;
  /**
   * Epic #1107 — the first-publication time this build renders for
   * published pages that were never live (ISO): the deploy run's
   * `started_at`, which Publish live then stores, so "latest news" and an
   * article's date in the shipped HTML match the stored value.
   */
  publishAt: string;
  /** Optional progress callback fired after each page is written. */
  onProgress?: ProgressCallback;
  /**
   * #1211 — fired right before the build is mirrored into `current/`
   * (only when `syncCurrent` is on): from then on the build is being
   * published and must not be stopped halfway.
   */
  onServing?: () => void;
  /**
   * #605 — every plugin answer the build needs. In the admin process the
   * local plugin host (`localBuildPluginServices`); in the generator
   * subprocess the admin's, reached over stdio (cli.ts). Required: a
   * build without the plugin host ships pages missing plugin output.
   */
  plugins: BuildPluginServices;
  /** P13 ideas-pass — incremental rebuild whitelist. When non-empty,
   *  only re-bake the listed page ids — plus every page whose render
   *  dependencies (`render-deps.json`, epic #1107) the change reaches;
   *  the rest are left alone in the build dir. Omitted = full rebuild. */
  changedPageIds?: ReadonlyArray<string>;
  /** Epic #1107 — shared lists changed since the last build (incremental). */
  changedListIds?: ReadonlyArray<string>;
  /** Epic #1107 — list types changed since the last build (incremental). */
  changedListTypeIds?: ReadonlyArray<string>;
  /**
   * #650 — the origin this build renders into every absolute URL
   * (canonical, sitemap, og:url, hreflang, robots `Sitemap:`) instead of
   * `site_defaults.site_base_url`. A staging build on a provider with its
   * own staging host (`https://staging.<domain>`) passes that host; Publish
   * live rebuilds the same content without it. Omitted = the stored site URL.
   */
  siteBaseUrlOverride?: string;
  /**
   * Mirror the finished build into `<outDir>/current/` (the directory the
   * self-hosted serving layer serves). Default true. #650 — Publish live's
   * rebuild passes false: the build must pass the parity guard before
   * anything serves it, and the publisher puts it live afterwards. #1003 —
   * cloud publishers pass false too: they upload the build directory and
   * nothing reads `current/`.
   */
  syncCurrent?: boolean;
  /**
   * How many builds to keep under `<outDir>/builds/` (default
   * {@link DEFAULT_RETAINED_BUILDS}: self-hosted rolls back to them). #1211
   * — 0 prunes nothing here: a cloud publisher uploads the build and the
   * admin deletes it right after, so no build stays in the container's
   * `/tmp` (memory on Cloud Run), and pruning would race a parallel build.
   */
  retainBuilds?: number;
  /**
   * #1271 — how the build carries the media and fonts it references:
   * `link` (default) hard-links them into the build directory, which is
   * then the whole site (self-hosted serves it; tests read it); `reference`
   * leaves them in their stores and lists them in
   * `_caelo-asset-references.json` for an uploading publisher (Firebase,
   * GCS), so not one media byte passes through the build.
   */
  mediaDelivery?: MediaDelivery;
}): Promise<GenerateResult> {
  const start = Date.now();
  const timer = PhaseTimer.withMemory();
  try {
    return await buildSite(args, start, timer);
  } finally {
    timer.close();
  }
}

/** The body of {@link generateSite}. */
async function buildSite(
  args: Parameters<typeof generateSite>[0],
  start: number,
  timer: PhaseTimer,
): Promise<GenerateResult> {
  const { tx, target, runId } = args;
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error(`static-generator: invalid runId "${runId}"`);
  }
  const root = args.repoRoot ?? process.cwd();
  const outDir = resolve(root, target.outDir);
  const buildsDir = join(outDir, "builds");
  const buildDir = join(buildsDir, runId);
  const currentLink = join(outDir, "current");

  // #551 — read first: a missing site base URL or site language fails the
  // run before any file is written, not halfway through the page passes.
  const storedSeo = requireSiteLanguage(await readSeoSettings(tx));
  const seoSettings = args.siteBaseUrlOverride
    ? { ...storedSeo, siteBaseUrl: args.siteBaseUrlOverride }
    : storedSeo;

  await mkdir(buildDir, { recursive: true });

  // Epic #1107 — lists of the whole build, loaded once: menus, page
  // queries and system sources resolve per page from this, and the
  // incremental selection below reads the page index from it.
  const listData = await loadBuildListRenderData(tx, {
    env: target.env,
    plugins: args.plugins,
    publishAt: args.publishAt,
  });
  const change: BuildChange = {
    pageIds: args.changedPageIds ?? [],
    listIds: args.changedListIds ?? [],
    listTypeIds: args.changedListTypeIds ?? [],
  };
  const incremental = isIncremental(change);
  const previousDeps = incremental ? await readTargetRenderDeps(outDir) : null;
  // null = every page (full build, or no deps recorded yet for this target).
  const pagesToBuild = incremental ? incrementalPageIds(change, previousDeps, listData) : null;

  // P13 ideas-pass — incremental whitelist filter when caller supplied
  // changedPageIds. Empty list / undefined = full-site build.
  // v0.2.80 — drizzle's bound-array interpolation through bun-sql
  // produces invalid SQL (`ANY(($1)::uuid[])` with a scalar param)
  // inside transactions, so the v0.2.79 cascade-driven Stage was
  // failing immediately when the form action passed a non-empty
  // changedPageIds (pre-v0.2.79 the form never did, so this code
  // path was never exercised in production). Inline the UUID list
  // as a literal — Zod validates each as a UUID upstream; the
  // regex below is defense-in-depth in case a future schema
  // relaxation removes that guard. Same workaround as
  // packages/admin-core/src/ops/snapshots/publish_impact_pages.ts.
  const incrementalFilter =
    pagesToBuild !== null
      ? pagesToBuild.length > 0
        ? sql.raw(` AND p.id = ANY(${uuidArrayLiteral(pagesToBuild)}::uuid[])`)
        : sql.raw(" AND false")
      : sql.raw("");
  // v0.9.9 — Stage ≡ Production: both filter to status='published'.
  // Drafts are a live-edit-only concept (visible in /edit's iframe +
  // picker so the editor sees their WIP) and MUST NOT reach either
  // deployed environment. The editor flips status via the top-bar
  // toggle in /edit when a page is ready to ship.
  //
  // v0.9.8 briefly inverted this — staging rendered drafts so the
  // operator could "preview before publish". That broke the Stage ≡
  // Production invariant (deploy.promote symlinks staging's exact
  // build to production, so drafts would leak to prod). Reverted.
  //
  // `dev` keeps the no-filter shape because dev is a debugging
  // surface; it's never reachable from the editor's promote flow.
  const statusFilter = target.env === "dev" ? sql.raw("") : sql.raw(" AND p.status = 'published'");
  // #1271 — one lean row per page; each template's and layout's HTML is
  // loaded once (below), not repeated in every page's row.
  const pageRows = (await tx.execute(sql`
    SELECT p.id::text AS page_id,
           p.slug, p.current_path, p.title, p.status,
           t.id::text AS template_id,
           l.id::text AS layout_id
    FROM pages p
    JOIN templates t ON t.id = p.template_id
    JOIN layouts l   ON l.id = t.layout_id
    WHERE p.deleted_at IS NULL
      AND t.deleted_at IS NULL
      AND l.deleted_at IS NULL
      ${statusFilter}
      -- v0.9.0 — main-only. Branched-create entities (pages /
      -- templates / layouts tagged with chat_branch_id) are
      -- chat-scoped previews and MUST NOT ship to production or
      -- staging. The picker / chat.merge_to_main is the only path
      -- that promotes branched entities to main.
      AND p.chat_branch_id IS NULL
      AND t.chat_branch_id IS NULL
      AND l.chat_branch_id IS NULL
      ${incrementalFilter}
    ORDER BY p.slug ASC
  `)) as unknown as PageRow[];

  const zeroPageError = zeroPageBuildError({
    pageCount: pageRows.length,
    env: target.env,
    incremental: pagesToBuild !== null,
  });
  if (zeroPageError !== null) throw new Error(zeroPageError);

  // #802 — the designated 404 page ships as /404.html, not at its path.
  const notFoundPageId = await readNotFoundPageId(tx);
  const notFoundError = notFoundPageBuildError({
    notFoundPageId,
    builtPageIds: pageRows.map((p) => p.page_id),
    env: target.env,
    incremental: pagesToBuild !== null,
  });
  if (notFoundError !== null) throw new Error(notFoundError);
  const outputPathOf = (p: PageRow): string =>
    builtPageOutputPath(
      { pageId: p.page_id, currentPath: p.current_path },
      notFoundPageId,
      target.pageUrlStyle,
    );

  // #390 — the emitted path IS pages.current_path (home designation,
  // prefixes and slug formats are materialized there by the write ops),
  // so generator + canonical + sitemap agree by construction.

  // #590 — the one style every URL of this build follows: emitted file
  // paths, canonical, sitemap, and the page links plugins list.
  const pageUrlStyle = target.pageUrlStyle ?? "directory";

  // issue #302 — fail loudly when no page will land at the bucket root.
  const plannedPaths = pageRows.map(outputPathOf);
  const rootEligibleSlugs = pageRows.map((p) => p.slug);
  const rootError = missingRootPageError({
    outputPaths: plannedPaths,
    rootEligibleSlugs,
    env: target.env,
    incremental: pagesToBuild !== null,
  });
  if (rootError !== null) throw new Error(rootError);
  const templates = new Map<string, { html: string; css: string }>();
  const layouts = new Map<string, { slug: string; html: string; css: string }>();
  {
    const templateIds = [...new Set(pageRows.map((p) => p.template_id))];
    const layoutIds = [...new Set(pageRows.map((p) => p.layout_id))];
    const ids = (list: string[]) => sql.raw(uuidArrayLiteral(list));
    if (templateIds.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, html, css FROM templates WHERE id = ANY(${ids(templateIds)}::uuid[])
      `)) as unknown as { id: string; html: string; css: string }[];
      for (const r of rows) templates.set(r.id, { html: r.html, css: r.css });
    }
    if (layoutIds.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, slug, html, css FROM layouts WHERE id = ANY(${ids(layoutIds)}::uuid[])
      `)) as unknown as { id: string; slug: string; html: string; css: string }[];
      for (const r of rows) layouts.set(r.id, { slug: r.slug, html: r.html, css: r.css });
    }
  }
  timer.lap("load-pages");

  // P6.7.6 — load layout modules once for the whole build, keyed by
  // layout_id. Per-page composition picks its layout's set — re-querying
  // per page would be wasteful and could surface rebuild-mid-deploy races
  // where some pages saw the old chrome and some the new.
  const layoutModRows = (await tx.execute(sql`
    SELECT lm.layout_id::text AS layout_id,
           lm.block_name AS block_name,
           lm.position   AS position,
           m.id::text    AS module_id,
           m.slug        AS slug,
           m.display_name AS display_name,
           m.html        AS html,
           m.css         AS css,
           m.js          AS js,
           m.fields::text AS fields
    FROM layout_modules lm JOIN modules m ON m.id = lm.module_id
    WHERE m.deleted_at IS NULL
      -- v0.9.0 — main-only; branched modules don't ship.
      AND m.chat_branch_id IS NULL
    ORDER BY lm.layout_id, lm.block_name ASC, lm.position ASC
  `)) as unknown as {
    layout_id: string;
    block_name: string;
    position: number;
    module_id: string;
    slug: string;
    display_name: string;
    html: string;
    css: string;
    js: string;
    fields: string | null;
  }[];
  const layoutModulesByLayout = new Map<string, Map<string, LayoutModule[]>>();
  for (const r of layoutModRows) {
    let perLayout = layoutModulesByLayout.get(r.layout_id);
    if (!perLayout) {
      perLayout = new Map();
      layoutModulesByLayout.set(r.layout_id, perLayout);
    }
    const arr = perLayout.get(r.block_name) ?? [];
    arr.push({
      moduleId: r.module_id,
      slug: r.slug,
      displayName: r.display_name,
      html: r.html,
      css: r.css,
      js: r.js,
      fields: parseModuleFields(r.fields),
    });
    perLayout.set(r.block_name, arr);
  }

  // v0.11.0 — load the active theme once for the whole build. The
  // renderer emits <style data-source="theme"> from these tokens; the
  // four asset URLs feed the `{{theme_*_url}}` placeholders and the
  // composer's `<link rel="icon">` head tag.
  //
  // Asset URLs are built from the media SLUG (`/_caelo/media/<slug>`),
  // never the id: the media pass classifies a bare single-segment ref
  // as a slug, so an id-built `/_caelo/media/<uuid>` would be looked up
  // as a slug and fail the deploy as unresolved. Same join as the
  // preview's `loadActiveThemeForCompose`, so both surfaces emit the
  // same URL. A deleted asset (no live media row) drops the binding.
  const themeRows = (await tx.execute(sql`
    SELECT
      t.tokens                       AS tokens,
      t.logo_media_id::text          AS logo_media_id,
      la.slug                        AS logo_slug,
      la.mime                        AS logo_mime,
      t.logo_dark_media_id::text     AS logo_dark_media_id,
      lda.slug                       AS logo_dark_slug,
      lda.mime                       AS logo_dark_mime,
      t.favicon_media_id::text       AS favicon_media_id,
      fa.slug                        AS favicon_slug,
      fa.mime                        AS favicon_mime,
      EXISTS (
        SELECT 1 FROM media_variants fv
        WHERE fv.asset_id = fa.id AND fv.variant = ${FAVICON_VARIANT}
      )                              AS favicon_has_rendition,
      t.social_share_media_id::text  AS social_share_media_id,
      ssa.slug                       AS social_share_slug,
      ssa.mime                       AS social_share_mime
    FROM themes t
    LEFT JOIN media_assets la  ON la.id  = t.logo_media_id         AND la.deleted_at  IS NULL
    LEFT JOIN media_assets lda ON lda.id = t.logo_dark_media_id    AND lda.deleted_at IS NULL
    LEFT JOIN media_assets fa  ON fa.id  = t.favicon_media_id      AND fa.deleted_at  IS NULL
    LEFT JOIN media_assets ssa ON ssa.id = t.social_share_media_id AND ssa.deleted_at IS NULL
    WHERE t.is_active = true
    LIMIT 1
  `)) as unknown as Array<{
    tokens: unknown;
    logo_media_id: string | null;
    logo_slug: string | null;
    logo_mime: string | null;
    logo_dark_media_id: string | null;
    logo_dark_slug: string | null;
    logo_dark_mime: string | null;
    favicon_media_id: string | null;
    favicon_slug: string | null;
    favicon_mime: string | null;
    favicon_has_rendition: boolean;
    social_share_media_id: string | null;
    social_share_slug: string | null;
    social_share_mime: string | null;
  }>;
  let activeTheme: ComposeTheme | undefined;
  const tr = themeRows[0];
  if (tr) {
    const tokens = tr.tokens as ThemeDocument;
    const asset = (
      id: string | null,
      slug: string | null,
      mime: string | null,
    ): ComposeThemeAsset | null =>
      id === null || slug === null || mime === null
        ? null
        : { mediaId: id, url: buildMediaUrl(slug, "orig"), mime };
    activeTheme = {
      tokens,
      assets: {
        logo: asset(tr.logo_media_id, tr.logo_slug, tr.logo_mime),
        logoDark: asset(tr.logo_dark_media_id, tr.logo_dark_slug, tr.logo_dark_mime),
        favicon: faviconAsset(tr),
        socialShare: asset(tr.social_share_media_id, tr.social_share_slug, tr.social_share_mime),
      },
    };
  }

  // issue #150 — font pass. Resolve the theme's web fonts ONCE per
  // build (self-hosted: hotlinking fonts.googleapis.com is a GDPR
  // liability and a third-party request on the critical path), copy the
  // cached woff2 files into _assets/fonts/, and thread the @font-face
  // CSS + preload URLs into every page's compose input. An unresolvable
  // family fails the deploy loudly (CLAUDE.md §2) — the preview surface
  // already flagged it as `theme-font-unresolvable:<family>`, so a
  // deploy reaching this state is stale theme data, not a surprise.
  let themeFonts: ComposeFonts | undefined;
  let themeFontFiles: readonly { cachePath: string; relPath: string }[] = [];
  const fontsCacheDir = resolve(defaultFontsCacheDir(root));
  if (activeTheme !== undefined) {
    const themeTokens = activeTheme.tokens;
    const resolved = await resolveThemeFonts({
      readFont: fontReader(tx),
      tokens: activeTheme.tokens,
      loadFontUsage: () => loadSiteFontUsage(tx, themeTokens),
      cacheDir: fontsCacheDir,
      publicBasePath: "/_assets/fonts",
      // Pages a plugin assigns another locale still get every slice via
      // unicode-range; only the preload hint follows the site language.
      preloadLanguage: seoSettings.siteLanguage,
    });
    if (resolved.unresolved.length > 0) {
      throw new Error(
        `static-generator: ${resolved.unresolved.map(fontUnresolvableMarker).join(", ")} — ` +
          "the active theme names web fonts that could not be fetched, parsed or converted to WOFF2 " +
          "(FontDeliveryFailed:<slice>:<reason> names the slice that failed to derive from a registry face). " +
          "Fix the typography tokens (set_theme_tokens), re-import or replace the face in the font registry, " +
          "or restore access to the fonts source, then redeploy.",
      );
    }
    if (resolved.files.length > 0) {
      themeFonts = { css: resolved.css, preloads: resolved.preloads };
      themeFontFiles = resolved.files;
    }
  }

  timer.lap("load-site");
  let fileCount = 0;
  args.onProgress?.({ pagesDone: 0, pagesTotal: pageRows.length });

  // #1271 — the build holds no page beyond the batch it is on, and no
  // media or font byte at all. Pages are composed, rewritten and written
  // PAGE_BATCH at a time; what a later pass needs from every page (the
  // sitemap's entries, output paths, render deps, link warnings) is kept
  // as a small record per page. Media and fonts are referenced by their
  // stored digests (asset-references.ts): the publisher delivers them.
  const delivery: MediaDelivery = args.mediaDelivery ?? "link";
  const mediaSettings = await readMediaSettings(tx);
  const mediaRoot = resolve(root, process.env.MEDIA_ROOT_DIR ?? "data/media");
  const media = new MediaPass({ tx, buildDir, mediaRoot, settings: mediaSettings, delivery });
  // issue #150 — the resolved woff2 files, as references (or links into the
  // build) under _assets/fonts/, so the @font-face URLs injected by the
  // composer resolve on the deployed site.
  const fontAssets = await publishFontFiles({
    files: themeFontFiles,
    fontsCacheDir,
    buildDir,
    delivery,
  });
  fileCount += fontAssets.length;
  const shippedFonts = new Set(themeFontFiles.map((f) => f.relPath));
  // #650 — the parity digests, taken from each file's bytes as it is
  // written; a Stage with its own staging host also records them with that
  // host swapped back to the live one (parity-digest.ts).
  const parity = new ParityRecorder(
    args.siteBaseUrlOverride
      ? hostNormaliser(args.siteBaseUrlOverride, storedSeo.siteBaseUrl)
      : null,
  );
  const writeBuildFile = async (relPath: string, content: string): Promise<void> => {
    const filePath = resolve(buildDir, relPath);
    if (!filePath.startsWith(`${buildDir}/`)) {
      throw new Error(`static-generator: output path "${relPath}" escapes build directory`);
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    parity.record(relPath, content);
  };

  // Plugin list sources are resolved per batch (one call per contributing
  // plugin and batch). Names declared by installed-but-inactive plugins
  // come along so a module still iterating a switched-off plugin's source
  // emits the loud marker here exactly as it does in the editor preview.
  const dormantSources = await args.plugins.dormantListSourceNames();
  // #450 — withheld modules, resolved ONCE for the build. Asking per
  // page would be one plugin round-trip per page for a verdict that is
  // per MODULE; the module set is the same question every time.
  // The gate judges the content this build ships — module code plus
  // every main-line content instance — not a verdict a background scan
  // recorded before the latest edit.
  const deferredModules = await resolveDeferredModules(tx, args.plugins);
  const noLayoutModules = new Map<string, VariantComposeModule[]>();
  // Modules embedded in shared list entries (a mega menu's teaser): every
  // batch's nested-module load includes them.
  const listModuleRefs = collectListModuleRefs(listData);
  const linkIndex = await loadBuildLinkIndex(tx, target.env, pageUrlStyle, args.plugins);
  const listContext = createListRenderContext(listData, { dormantPluginSources: dormantSources });
  const renderDeps = new Map<string, ListRenderDeps>();
  const overlayIssues = [...listContext.overlayIssues];
  const unpublishedLinkTargets: UnpublishedLinkTarget[] = [];
  // #1257 — paginated overviews: their follow-up files, and lists cut at the cap.
  const followUpOutputPaths = new Map<string, string[]>();
  const truncatedLists: TruncatedListReport[] = [];
  // Every page path of the build's env, for the follow-up collision check —
  // read once, when the first paginated overview is met.
  let allPagePaths: string[] | null = null;
  const outputPaths = new OutputPathRegistry();
  const renderFailures: RenderFailure[] = [];
  const contentTypeOverrides: Record<string, string> = {};

  const seo = await prepareSeoPass({
    tx,
    plugins: args.plugins,
    media,
    pageIds: pageRows.map((p) => p.page_id),
    settings: seoSettings,
    pageUrlStyle,
    notFoundPageId,
  });
  // #449 — plugin client assets: one call per contributing plugin for
  // the whole build, written under `_caelo/plugin/<slug>/` with the
  // content hash in the name, then referenced from every page.
  const clientAssets = await args.plugins.collectBuildAssets(pageRows.map((p) => p.page_id));
  for (const asset of clientAssets) {
    await writeBuildFile(asset.relPath, asset.content);
    fileCount += 1;
  }
  const pluginListNames = await args.plugins.declaredListSourceNames();
  const minifyCache = new MinifyCache();
  const bakes = new BakeStore();
  timer.lap("load-content");

  // issue #302 / #1257 — a page file that other pages need as a folder:
  // named before any page is written (follow-up pages are added per batch).
  for (const p of pageRows) outputPaths.add(outputPathOf(p));
  outputPaths.assertNone();

  const parts = new Map<string, { ms: number; peakRssMb?: number }>();
  let pagesDone = 0;
  for (let at = 0; at < pageRows.length; at += PAGE_BATCH) {
    const batch = pageRows.slice(at, at + PAGE_BATCH);
    const loaded = await timer.measure(parts, "load-batch", () =>
      loadBatch({
        tx,
        plugins: args.plugins,
        batch,
        layoutModulesByLayout,
        noLayoutModules,
        listModuleRefs,
        pageUrlStyle,
      }),
    );
    const pages: BuiltPage[] = [];
    const bakeTargets = new Map<string, BakeTarget>();
    const paginatedOverviews: { path: string; slug: string }[] = [];
    await timer.measure(parts, "compose", () => {
      for (const page of batch) {
        const composeInput = loaded.composeInputs.get(page.page_id);
        if (!composeInput) continue;
        const { blocks, layoutBlocks } = composeInput;
        const template = templates.get(page.template_id);
        const layout = layouts.get(page.layout_id);
        if (!template || !layout) {
          throw new Error(
            `static-generator: page slug=${page.slug}: its template or layout was not loaded`,
          );
        }
        // P6.7.6 — composer throws ComposeError on layout misconfiguration
        // (e.g. layout HTML missing the required `content` slot). Surface
        // it with the page slug so the deploy operator can locate the
        // offending row, rather than silently emitting a body-less page.
        const renderAt = (pagination?: PaginationRequest) => {
          const linkResolver = linkIndex.forPage(page.page_id);
          const lists = listContext.forPage(page.page_id, {
            linkResolver,
            pluginSources: loaded.sources.get(page.page_id) ?? {},
            pageUrlStyle,
            ...(pagination ? { pagination } : {}),
          });
          try {
            const composed = composePageWithLayout({
              templateHtml: template.html,
              templateCss: template.css,
              blocks,
              theme: activeTheme,
              fonts: themeFonts,
              layoutHtml: layout.html,
              layoutCss: layout.css,
              layoutBlocks,
              layoutSlug: layout.slug,
              lists,
              deferredModules,
              nestedModules: loaded.nestedModules,
              linkResolver,
            });
            return { composed, lists, linkResolver };
          } catch (e) {
            if (e instanceof ComposeError) {
              throw new Error(`static-generator: page slug=${page.slug}: ${e.message}`);
            }
            throw e;
          }
        };
        // #1257 — a paginated overview renders every page of its sequence:
        // page 1 at its own path, page n at `<path>/page/<n>/`.
        const renders = renderEveryPage(renderAt);
        const pagination = renders[0]?.lists.pagination() ?? null;
        assertPaginationRenderable(page, pagination, notFoundPageId);
        if (renders.length > 1)
          paginatedOverviews.push({ path: page.current_path, slug: page.slug });

        renderDeps.set(page.page_id, mergeListRenderDeps(renders.map((r) => r.lists.deps())));
        const seenTargets = new Set<string>();
        renders.forEach(({ composed, lists, linkResolver }, index) => {
          const n = index + 1;
          for (const issue of lists.overlayIssues()) {
            if (
              !overlayIssues.some((i) => i.address === issue.address && i.variant === issue.variant)
            ) {
              overlayIssues.push(issue);
            }
          }
          pages.push({
            html: composed.html,
            pageId: page.page_id,
            pageSlug: page.slug,
            pageTitle: page.title,
            relPath:
              n === 1
                ? outputPathOf(page)
                : pageOutputPath(pagedPath(page.current_path, n), target.pageUrlStyle),
            breadcrumbTrail: lists.breadcrumbTrail(),
            ...(n > 1 && pagination
              ? { followUp: { page: n, indexable: pagination.followUps === "index" } }
              : {}),
          });
          // A module whose content could not render (a broken nested ref, a
          // malformed list item, …) would ship as a silently empty section.
          // Collected for every page of the build, then refused with all of
          // them named (assertNoRenderFailures).
          renderFailures.push(
            ...renderFailuresOf({
              pageSlug: n === 1 ? page.slug : `${page.slug} (page ${n})`,
              html: composed.html,
              moduleFailures: composed.moduleFailures,
              // #724 — a reference in the layout's own HTML that did not resolve.
              layoutLinkMarkers: linkMarkersOf(composed.missingSlots),
            }),
          );
          for (const o of linkResolver.observed) {
            if (o.resolution.status !== "unpublished") continue;
            // The page the link renders to — the referenced page, or its
            // sibling in this page's variant (link-resolve point).
            const targetPageId = o.resolution.pageId;
            if (seenTargets.has(targetPageId)) continue;
            seenTargets.add(targetPageId);
            unpublishedLinkTargets.push({
              pageSlug: page.slug,
              pagePath: page.current_path,
              targetPageId,
              targetUrl: o.resolution.url,
            });
          }
        });
        for (const cut of renders[0]?.lists.truncatedLists() ?? []) {
          // #1257 — a list cut by the query cap (not a chosen teaser limit).
          if (cut.limit < LIST_QUERY_MAX_LIMIT) continue;
          truncatedLists.push({ pageSlug: page.slug, pagePath: page.current_path, ...cut });
        }
        if (renders.length > 1) {
          followUpOutputPaths.set(
            page.page_id,
            renders
              .slice(1)
              .map((_, i) =>
                pageOutputPath(pagedPath(page.current_path, i + 2), target.pageUrlStyle),
              ),
          );
        }
        // P13 — record per-page bake target for the plugin render pass.
        bakeTargets.set(page.page_id, { pageId: page.page_id, slug: page.slug });
      }
    });
    pagesDone += batch.length;
    // A render failure anywhere fails the build: the remaining batches are
    // still composed, so the error names every failure, but nothing more
    // is written.
    if (renderFailures.length > 0) {
      args.onProgress?.({ pagesDone, pagesTotal: pageRows.length });
      continue;
    }
    // #1257 — a page where an overview puts its follow-up pages.
    if (paginatedOverviews.length > 0) {
      allPagePaths ??= await loadAllPagePaths(tx, statusFilter);
      const collision = followUpCollisionError(paginatedOverviews, allPagePaths);
      if (collision !== null) throw new Error(collision);
      for (const p of pages) if (p.followUp) outputPaths.add(p.relPath);
      outputPaths.assertNone();
    }

    await timer.measure(parts, "media", async () => {
      // A module may carry the editor preview's font URL (/_caelo/fonts/...),
      // which only the admin serves: point it at the shipped file, or fail.
      rewritePreviewFontUrls(pages, shippedFonts);
      // P7 — swap /_caelo/media/... URLs for the content-hashed /_assets/...
      // paths of the stored files (#667, #1271: by stored digest, no read).
      await media.rewritePages(pages);
    });
    // P8 — SEO: per-page <head> meta + canonical + JSON-LD (env-independent
    // so promote can ship a staging build verbatim; staging's noindex lives
    // in robots.txt + the X-Robots-Tag header — see seo-pass.ts).
    await timer.measure(parts, "seo", () => seo.apply(pages));
    // P13 — plugin render pass: each active Tier-1 plugin's `staticRender`
    // spliced in at its placeholder; cache hits via static_bakes skip it.
    await timer.measure(parts, "plugin-render", () =>
      runPluginRenderPass({
        tx,
        plugins: args.plugins,
        pages,
        bakeTargets,
        pageUrlStyle,
        bakes,
      }),
    );
    await timer.measure(parts, "plugin-assets", () => {
      // Runs AFTER the plugin render pass so a runtime that hydrates baked
      // markup is guaranteed to find it already in the document.
      for (const p of pages) p.html = injectPluginAssets(p.html, clientAssets, "linked");
      // #605 — a plugin list-source section that survived composition means
      // the page would ship raw `{{#source}}` markers to visitors.
      assertNoPluginMarkers(pages, pluginListNames);
    });
    // issue #158 — minify the composer's inline CSS/JS last, after every
    // pass that still rewrites inside them (media URLs, plugin assets).
    // esbuild's service minifies in parallel across the cores.
    await timer.measure(parts, "minify", () => minifyPageAssets(pages, minifyCache));
    await timer.measure(parts, "write", async () => {
      // v0.2.85 — per-key Content-Type sidecar: bare-slug pages
      // ('no-extension') cannot be typed from the extension.
      for (const p of pages) {
        if (target.pageUrlStyle === "no-extension" && !p.relPath.endsWith(".html")) {
          contentTypeOverrides[p.relPath] = "text/html; charset=utf-8";
        }
      }
      // #1003 — the files in parallel batches: written one at a time this
      // was seconds on a few thousand pages.
      await runBatched(pages, WRITE_PARALLELISM, (p) => writeBuildFile(p.relPath, p.html));
    });
    fileCount += pages.length;
    args.onProgress?.({ pagesDone, pagesTotal: pageRows.length });
  }
  timer.lapParts(parts, "batches");
  // P13 — every fresh plugin bake of the build, upserted in one order.
  await bakes.flush(tx);

  assertNoRenderFailures(renderFailures);
  // A `list-resolve` overlay entry the resolver refused (unknown address,
  // structural change) is the plugin's fault, not the site's: the stored
  // value rendered instead, and the plugin's error channel says so
  // (plugin_errors → list_plugins / Settings → Plugins, #1008).
  for (const i of overlayIssues) {
    console.warn(
      `[static-generator] list overlay for variant "${i.variant}" refused at ${i.address}: ${i.reason}`,
    );
  }
  if (overlayIssues.length > 0 && listData.overlaySources) {
    await args.plugins.reportListOverlayIssues(listData.overlaySources, overlayIssues);
  }

  const sitemapEmitted = await seo.writeSitemap(writeBuildFile);
  if (sitemapEmitted) fileCount += 1;
  // cdn_manifest.json is always written.
  await media.finish();
  fileCount += 1;
  timer.lap("finish-pages");

  await writeFile(
    join(buildDir, "robots.txt"),
    buildRobotsTxtWithSitemap(target.robotsDefault, seoSettings.siteBaseUrl, sitemapEmitted),
    "utf8",
  );
  fileCount += 1;

  const manifest = {
    target: target.name,
    env: target.env,
    runId,
    builtAt: new Date().toISOString(),
    pageCount: pageRows.length,
    // #1155 — `pageId` lets a plugin-data build find a page's file in the
    // build that is live, without reading the (possibly unpublished)
    // current page paths from cms_admin.
    pages: pageRows.map((p) => {
      const followUps = followUpOutputPaths.get(p.page_id);
      return {
        pageId: p.page_id,
        slug: p.slug,
        path: p.current_path,
        outputPath: outputPathOf(p),
        // #1257 — the files of pages 2… of a paginated overview.
        ...(followUps ? { followUpOutputPaths: followUps } : {}),
      };
    }),
    // #802 — the error page every provider serves for unknown URLs, or
    // null when none is designated (the host's generic page answers).
    notFoundPage:
      notFoundPageId !== null && pageRows.some((p) => p.page_id === notFoundPageId)
        ? NOT_FOUND_PAGE_FILE
        : null,
    // Promote guard — see manifestBakesEnvNoindex.
    envNoindexInHtml: false,
  };
  await writeFile(
    join(buildDir, "routing-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  fileCount += 1;
  // Epic #1107 — what every page's render read, for the next incremental build.
  await writeRenderDeps({
    outDir,
    buildDir,
    previous: previousDeps,
    rebuilt: renderDeps,
    data: listData,
    full: pagesToBuild === null,
  });
  fileCount += 1;

  // #587 — the redirects table, served at the edge on every provider
  // (redirects-pass.ts writes the files once the build is complete).
  const redirectRows = (await tx.execute(sql`
    SELECT from_path, to_path, status_code FROM redirects
    ORDER BY from_path
  `)) as unknown as { from_path: string; to_path: string; status_code: number }[];
  // #657 — every format below writes `to_path` verbatim into a Location
  // header. A row stored before the op-level target validation existed
  // (`//host`, `/https://…`) would ship as an open redirect or a broken
  // 301, so the build fails loudly and names the rows instead.
  const unsafeTargets = redirectRows.flatMap((r) => {
    const issue = redirectTargetIssue(r.to_path);
    return issue ? [`${r.from_path} → ${issue}`] : [];
  });
  if (unsafeTargets.length > 0) {
    throw new Error(
      `static-generator: ${unsafeTargets.length} redirect(s) have an unsafe target; fix each with redirects.create_many (upsert: true, a same-site toPath) or delete it with redirects.delete_many, then rebuild:\n  ${unsafeTargets.join("\n  ")}`,
    );
  }
  // v0.2.85 — emit the content-type sidecar even when empty so
  // the publisher can rely on its presence to determine the
  // pageUrlStyle indirectly. Skipped from `_redirects` collisions
  // because the sidecar key is `_content-types.json` (extension
  // makes the inference unambiguous + the file itself is JSON).
  await writeBuildFile("_content-types.json", JSON.stringify(contentTypeOverrides, null, 2));
  fileCount += 1;

  fileCount += await writeRedirectFiles({
    buildDir,
    rows: redirectRows.map((r) => ({
      fromPath: r.from_path,
      toPath: r.to_path,
      statusCode: r.status_code,
    })),
    pageUrlStyle,
  });

  // #1271 — what the publisher delivers from the stores, and the parity
  // digests of every served file (pages were digested as they were
  // written; the few files other passes wrote are read now).
  const assets = [...media.assets(), ...fontAssets];
  await writeFile(
    join(buildDir, ASSET_REFERENCES_FILE),
    serializeAssetReferences({ version: 1, mediaRoot, fontsCacheDir, assets }),
    "utf8",
  );
  const assetPaths = new Set(assets.map((a) => a.path));
  await parity.finish({
    buildDir,
    assets,
    unrecorded: (await listBuildFiles(buildDir)).filter(
      (rel) => !parity.has(rel) && !assetPaths.has(rel) && !BUILD_INTERNAL_FILES.has(rel),
    ),
  });
  timer.lap("manifests");
  // Atomic-ish swap. `current/` is a regular directory (not a symlink)
  // because Docker Desktop / VirtioFS bind mounts on macOS don't follow
  // symlinks reliably across the host/container boundary. We sync the
  // build dir's contents into `current/` in place — same files, same
  // dirs, the bind mount stays valid because the directory inode never
  // changes. The `builds/<runId>/` archive stays for content-addressed
  // history and for `deploy.rollback` to copy back when invoked.
  if (args.syncCurrent !== false) {
    // #1211 — from here the build is being published: the caller may no
    // longer stop it (cli.ts serving-guard.ts).
    args.onServing?.();
    await mkdir(currentLink, { recursive: true });
    await syncContents(buildDir, currentLink);
    timer.lap("sync-current");
  }

  // Best-effort old-build retention: keep the most recent ones, remove the
  // rest. Failures are swallowed because they don't affect the live
  // serving target (which is `current/`).
  const retainBuilds = args.retainBuilds ?? DEFAULT_RETAINED_BUILDS;
  if (retainBuilds > 0) {
    await pruneOldBuilds(buildsDir, runId, retainBuilds);
    timer.lap("prune");
  }

  return {
    pageCount: pageRows.length,
    fileCount,
    durationMs: Date.now() - start,
    phases: timer.phases(),
    buildDir,
    // maxRSS is in KiB on Linux and macOS alike under Bun.
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    unpublishedLinkTargets,
    truncatedLists,
  };
}

/** Every file below `dir`, relative and `/`-separated. */
async function listBuildFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else out.push(childRel);
    }
  };
  await walk("");
  return out;
}

/** #1257 — every page path of the build's env (the follow-up collision check). */
async function loadAllPagePaths(
  tx: TransactionRunner,
  statusFilter: ReturnType<typeof sql.raw>,
): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT p.current_path FROM pages p
    WHERE p.deleted_at IS NULL AND p.chat_branch_id IS NULL ${statusFilter}
  `)) as unknown as { current_path: string }[];
  return rows.map((r) => r.current_path);
}

/** One rendered page file of a batch, as every per-page pass rewrites it. */
interface BuiltPage {
  html: string;
  /** Identity for every per-page pass (slugs repeat across parents). */
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  relPath: string;
  /** #1142 — the trail the page's breadcrumbs showed, for the BreadcrumbList JSON-LD. */
  breadcrumbTrail: readonly string[] | null;
  /** #1257 — page `n` ≥ 2 of a paginated overview, and whether it may be indexed. */
  followUp?: { page: number; indexable: boolean };
}

/** Builds a self-hosted target keeps under `builds/` for rollback. */
export const DEFAULT_RETAINED_BUILDS = 5;

async function pruneOldBuilds(buildsDir: string, keepRunId: string, retain: number): Promise<void> {
  try {
    const entries = await readdir(buildsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length <= retain) return;
    // Keep the most recent `retain` by mtime (proxied by name; UUIDs sort
    // lexicographically — fine for ordering, not strictly chronological,
    // so we additionally never delete keepRunId).
    const sorted = dirs.sort();
    const toDrop = sorted.slice(0, sorted.length - retain);
    for (const name of toDrop) {
      if (name === keepRunId) continue;
      await rm(join(buildsDir, name), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Builds dir doesn't exist yet, nothing to prune.
  }
}

/**
 * The bound favicon as the `<link rel="icon">` links it: a raster favicon
 * ships its small PNG rendition (`FAVICON_VARIANT`), ICO/SVG their own
 * bytes. `themes.set_asset` creates the rendition when the favicon is
 * bound, and `deploy.trigger` creates it (`themes.ensure_favicon_rendition`)
 * before the generator starts for a favicon bound before that rule. A
 * rendition still missing here means the build was started outside that
 * path: fail loudly instead of shipping the multi-MB original (CLAUDE.md
 * §2 — that original cost the page its LCP).
 */
export function faviconAsset(row: {
  favicon_media_id: string | null;
  favicon_slug: string | null;
  favicon_mime: string | null;
  favicon_has_rendition: boolean;
}): ComposeThemeAsset | null {
  if (row.favicon_media_id === null || row.favicon_slug === null || row.favicon_mime === null) {
    return null;
  }
  if (isRasterImageMime(row.favicon_mime) && !row.favicon_has_rendition) {
    throw new Error(
      `static-generator: the theme favicon (media ${row.favicon_slug}, ${row.favicon_mime}) has no ${FAVICON_VARIANT} rendition, ` +
        "so the page would link the full-size original as its icon (a large download on every page load). " +
        "Stage creates it before the build (themes.ensure_favicon_rendition); this build was started without that step. " +
        `Next step: Stage again, or bind the favicon again (AI tool: set_theme_asset with slot "favicon" and mediaId ${row.favicon_media_id}).`,
    );
  }
  return {
    mediaId: row.favicon_media_id,
    ...themeFaviconRendition(row.favicon_slug, row.favicon_mime),
  };
}
