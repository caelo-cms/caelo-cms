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
 */

import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type BuildPluginServices, injectPluginAssets } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  ComposeError,
  type ComposeField,
  type ComposeFonts,
  type ComposeTheme,
  type ComposeThemeAsset,
  collectListModuleRefs,
  composePageWithLayout,
  createListRenderContext,
  FAVICON_VARIANT,
  fontUnresolvableMarker,
  isRasterImageMime,
  type ListRenderDeps,
  linkMarkersOf,
  PhaseTimer,
  type PhaseTiming,
  redirectTargetIssue,
  runBatched,
  type ThemeDocument,
  templateFieldsFromJson,
  themeFaviconRendition,
  trimSlashes,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import {
  applyContentVariants,
  resolveBuildContentVariants,
  type VariantComposeModule,
} from "./content-variants-pass.js";
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
import { readMediaSettings, runMediaPass } from "./media-pass.js";
import { minifyPageAssets } from "./minify-pass.js";
import {
  assertNoRenderFailures,
  loadNestedModules,
  type RenderedPageForGate,
} from "./nested-modules-pass.js";
import {
  NOT_FOUND_PAGE_FILE,
  notFoundPageBuildError,
  readNotFoundPageId,
} from "./not-found-page.js";
import { type BakeTarget, runPluginRenderPass } from "./plugin-pass.js";
import { rewritePreviewFontUrls } from "./preview-font-urls.js";
import { writeRedirectFiles } from "./redirects-pass.js";
import {
  buildRobotsTxtWithSitemap,
  readSeoSettings,
  requireSiteLanguage,
  runSeoPass,
} from "./seo-pass.js";
import { syncContents } from "./sync-contents.js";

/** Page files written at once: bounded so a large site cannot exhaust file descriptors. */
const WRITE_PARALLELISM = 32;

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
  /**
   * Epic #724 — internal links whose target page exists but is not
   * published, so this build does not contain it. Per the #724 decision
   * a warning at Stage; the blocking check for Publish live / promote
   * consumes the same list (rollout F). Missing targets never get here:
   * they fail the build in the render gate.
   */
  readonly unpublishedLinkTargets: readonly UnpublishedLinkTarget[];
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

interface PageRow {
  page_id: string;
  slug: string;
  /** The composed public path (pages.current_path, #390). */
  current_path: string;
  title: string;
  status: "draft" | "published";
  template_html: string;
  template_css: string;
  layout_id: string;
  layout_slug: string;
  layout_html: string;
  layout_css: string;
}

interface ModuleRow {
  page_id: string;
  block_name: string;
  position: number;
  module_id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
  fields: string | null;
  content_values: string | null;
  content_instance_id: string;
  sync_mode: "synced" | "unsynced";
  /** Set once content variants replaced the instance's values: no stored instance renders. */
  variant?: true;
}

/**
 * Parse the jsonb `modules.fields` column as it comes back from
 * `m.fields::text` into the fields the shared template engine renders
 * with (name, kind, default, a `list` field's binding — see
 * `templateFieldsFromJson`). Returns undefined when the column is null /
 * empty / malformed — the caller treats that as "no field-default
 * substitution to do" rather than throwing, so a legacy module with a
 * NULL fields column still ships.
 */
function parseModuleFields(raw: string | null): ComposeField[] | undefined {
  if (!raw) return undefined;
  try {
    const out = templateFieldsFromJson(raw);
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the jsonb `content_instances.values` column. Per-placement
 * override map keyed by module field name — see
 * `renderModuleFields` in `@caelo-cms/shared/preview-compose` for
 * substitution semantics. Returns undefined on null / malformed /
 * non-object so compose falls back to field defaults.
 */
function parseContentValues(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    return Object.keys(obj).length > 0 ? obj : undefined;
  } catch {
    return undefined;
  }
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
 * matching zero published pages is a routine no-op — e.g. the
 * auto-redeploy orchestrator reacting to a draft-page edit — not an
 * unservable site.
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
  /** P13 — adapter handle so the plugin render pass can read +
   *  upsert `static_bakes` outside the page-build transaction. */
  adapter: import("@caelo-cms/query-api").DatabaseAdapter;
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
   *  the rest are left alone in the build dir. Auto-redeploy passes the
   *  audit_events tail's touched page ids; manual triggers omit it for
   *  full rebuild. */
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
}): Promise<GenerateResult> {
  const start = Date.now();
  const timer = new PhaseTimer();
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
  const pageRows = (await tx.execute(sql`
    SELECT p.id::text AS page_id,
           p.slug, p.current_path, p.title, p.status,
           t.html AS template_html,
           t.css  AS template_css,
           l.id::text AS layout_id,
           l.slug AS layout_slug,
           l.html AS layout_html,
           l.css  AS layout_css
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
  const layoutModulesByLayout = new Map<
    string,
    Map<
      string,
      {
        moduleId: string;
        slug: string;
        displayName: string;
        html: string;
        css: string;
        js: string;
        fields?: ComposeField[];
      }[]
    >
  >();
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
    const tokens: ThemeDocument =
      typeof tr.tokens === "string"
        ? (JSON.parse(tr.tokens) as ThemeDocument)
        : (tr.tokens as ThemeDocument);
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
  if (activeTheme !== undefined) {
    const themeTokens = activeTheme.tokens;
    const resolved = await resolveThemeFonts({
      readFont: fontReader(tx, {
        actorId: "00000000-0000-0000-0000-00000000ffff",
        actorKind: "system",
        requestId: "font-build",
      }),
      tokens: activeTheme.tokens,
      loadFontUsage: () => loadSiteFontUsage(tx, themeTokens),
      cacheDir: defaultFontsCacheDir(root),
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

  // Compose pages first (in memory), then run the media pass to
  // rewrite /_caelo/media/... URLs and copy variant bytes into
  // _assets/, then write the per-page HTML files. Two-pass keeps the
  // media-pass deduped across pages — every (asset, variant) pair is
  // copied once even when 50 pages reference it.
  const composedPages: {
    html: string;
    /** Identity for every per-page pass (slugs repeat across parents). */
    pageId: string;
    pageSlug: string;
    pageTitle: string;
    relPath: string;
    /** #1142 — the trail the page's breadcrumbs showed, for the BreadcrumbList JSON-LD. */
    breadcrumbTrail: readonly string[] | null;
  }[] = [];
  // P13 — per-page bake target for the plugin render pass, keyed by page
  // id: slugs are not unique once pages nest (epic #690).
  const bakeTargets = new Map<string, BakeTarget>();
  // Plugin list sources for the whole deploy, resolved in ONE call per
  // contributing plugin rather than per page. Names declared by
  // installed-but-inactive plugins come along so a module still
  // iterating a switched-off plugin's source emits the loud marker here
  // exactly as it does in the editor preview.
  const allSources = await args.plugins.resolveListSources(
    pageRows.map((p) => p.page_id),
    pageUrlStyle,
  );
  const dormantSources = await args.plugins.dormantListSourceNames();
  // #450 — withheld modules, resolved ONCE for the build. Asking per
  // page would be one plugin round-trip per page for a verdict that is
  // per MODULE; the module set is the same question every time.
  // The gate judges the content this build ships — module code plus
  // every main-line content instance — not a verdict a background scan
  // recorded before the latest edit.
  const candidateRows = (await tx.execute(sql`
    SELECT m.id::text AS id, m.html, m.css, m.js, m.fields::text AS fields,
           COALESCE(
             json_agg(ci.values) FILTER (WHERE ci.id IS NOT NULL),
             '[]'::json
           )::text AS content_values
    FROM modules m
      LEFT JOIN content_instances ci
        ON ci.module_id = m.id AND ci.chat_branch_id IS NULL
    WHERE m.deleted_at IS NULL
    GROUP BY m.id
  `)) as unknown as {
    id: string;
    html: string;
    css: string;
    js: string;
    fields: string | null;
    content_values: string;
  }[];
  const deferredModules = Object.fromEntries(
    await args.plugins.resolveModuleDeferrals(
      candidateRows.map((r) => ({
        moduleId: r.id,
        html: r.html,
        css: r.css,
        js: r.js,
        fields: r.fields ? JSON.parse(r.fields) : [],
        contentValues: JSON.parse(r.content_values) as unknown[],
      })),
    ),
  );
  // Page placements for every page up front: the content-variants
  // composition point (#592) resolves the whole build in one call.
  const modRowsByPage = new Map<string, ModuleRow[]>();
  for (const page of pageRows) {
    const modRows = (await tx.execute(sql`
      SELECT pm.block_name, pm.position,
             m.id::text AS module_id,
             m.slug, m.display_name, m.html, m.css, m.js, m.fields::text AS fields,
             ci.values::text AS content_values,
             pm.content_instance_id::text AS content_instance_id,
             pm.sync_mode
      FROM page_modules pm
        JOIN modules m            ON m.id  = pm.module_id
        -- PR #61 follow-up — every placement carries a
        -- content_instance_id (page_modules schema, v0.12.0); join
        -- is INNER because the column is NOT NULL. ci.values fills
        -- the module's curly-brace placeholders. Without this join
        -- the static-generator shipped raw placeholder text for
        -- AI-authored modules whose fields had no default.
        JOIN content_instances ci ON ci.id = pm.content_instance_id
      WHERE pm.page_id = ${page.page_id}::uuid
        AND m.deleted_at IS NULL
        -- v0.9.0 — main-only.
        AND m.chat_branch_id IS NULL
      ORDER BY pm.block_name ASC, pm.position ASC
    `)) as unknown as ModuleRow[];
    modRowsByPage.set(page.page_id, modRows);
  }
  const noLayoutModules = new Map<string, VariantComposeModule[]>();
  const variants = await resolveBuildContentVariants(
    tx,
    args.plugins,
    pageRows.map((page) => ({
      pageId: page.page_id,
      slug: page.slug,
      layoutId: page.layout_id,
      layoutBlocks: layoutModulesByLayout.get(page.layout_id) ?? noLayoutModules,
      pageBlocks: (modRowsByPage.get(page.page_id) ?? []).map((r) => ({
        blockName: r.block_name,
        position: r.position,
        module: {
          moduleId: r.module_id,
          slug: r.slug,
          displayName: r.display_name,
          html: r.html,
          css: r.css,
          js: r.js,
          fields: parseModuleFields(r.fields),
          contentValues: parseContentValues(r.content_values),
        },
        contentInstanceId: r.content_instance_id,
        synced: r.sync_mode === "synced",
      })),
    })),
  );

  // Every page's blocks as the composer will receive them (content
  // variants applied), so the nested-module load below sees exactly the
  // values that render.
  const composeInputsByPage = new Map<
    string,
    {
      blocks: ReturnType<typeof groupModulesByBlock>;
      layoutBlocks: ReturnType<typeof applyContentVariants>["layoutBlocks"];
    }
  >();
  for (const page of pageRows) {
    const modRows = modRowsByPage.get(page.page_id) ?? [];
    const applied = applyContentVariants(
      page.page_id,
      layoutModulesByLayout.get(page.layout_id) ?? noLayoutModules,
      modRows,
      variants.resolutions,
      variants.overrideModules,
    );
    const blocks = groupModulesByBlock(
      modRows.map((r) => {
        const values = applied.pageValues.get(r);
        // Variant content is no stored instance: its local list entries
        // carry no instance address (`docs/lists.md` §13).
        return values === undefined
          ? r
          : { ...r, content_values: JSON.stringify(values), variant: true as const };
      }),
    );
    composeInputsByPage.set(page.page_id, { blocks, layoutBlocks: applied.layoutBlocks });
  }
  // Modules reached only through a module / module-list field (cards in
  // a grid, plans in a pricing table) have no placement row of their
  // own; load them so the composer renders them recursively, exactly as
  // the editor preview does.
  const nestedModules = await loadNestedModules(
    tx,
    [...composeInputsByPage.values()].flatMap((c) =>
      [...c.blocks, ...c.layoutBlocks].flatMap((b) => b.modules),
    ),
    // Modules embedded in shared list entries (a mega menu's teaser).
    collectListModuleRefs(listData),
  );
  const renderedForGate: RenderedPageForGate[] = [];
  const linkIndex = await loadBuildLinkIndex(tx, target.env, pageUrlStyle, args.plugins);
  const listContext = createListRenderContext(listData, { dormantPluginSources: dormantSources });
  const renderDeps = new Map<string, ListRenderDeps>();
  const overlayIssues = [...listContext.overlayIssues];
  const unpublishedLinkTargets: UnpublishedLinkTarget[] = [];
  timer.lap("load-content");

  for (let i = 0; i < pageRows.length; i++) {
    const page = pageRows[i];
    if (!page) continue;
    const composeInput = composeInputsByPage.get(page.page_id);
    if (!composeInput) continue;
    const { blocks, layoutBlocks } = composeInput;
    // P6.7.6 — composer throws ComposeError on layout misconfiguration
    // (e.g. layout HTML missing the required `content` slot). Surface
    // it with the page slug so the deploy operator can locate the
    // offending row, rather than silently emitting a body-less page.
    let composed: ReturnType<typeof composePageWithLayout>;
    const linkResolver = linkIndex.forPage(page.page_id);
    const lists = listContext.forPage(page.page_id, {
      linkResolver,
      pluginSources: allSources.get(page.page_id) ?? {},
    });
    try {
      composed = composePageWithLayout({
        templateHtml: page.template_html,
        templateCss: page.template_css,
        blocks,
        theme: activeTheme,
        fonts: themeFonts,
        layoutHtml: page.layout_html,
        layoutCss: page.layout_css,
        layoutBlocks,
        layoutSlug: page.layout_slug,
        lists,
        deferredModules,
        nestedModules,
        linkResolver,
      });
    } catch (e) {
      if (e instanceof ComposeError) {
        throw new Error(`static-generator: page slug=${page.slug}: ${e.message}`);
      }
      throw e;
    }

    renderDeps.set(page.page_id, lists.deps());
    for (const issue of lists.overlayIssues()) {
      if (!overlayIssues.some((i) => i.address === issue.address && i.variant === issue.variant)) {
        overlayIssues.push(issue);
      }
    }
    composedPages.push({
      html: composed.html,
      pageId: page.page_id,
      pageSlug: page.slug,
      pageTitle: page.title,
      relPath: outputPathOf(page),
      breadcrumbTrail: lists.breadcrumbTrail(),
    });
    renderedForGate.push({
      pageSlug: page.slug,
      html: composed.html,
      moduleFailures: composed.moduleFailures,
      // #724 — a reference in the layout's own HTML that did not resolve.
      layoutLinkMarkers: linkMarkersOf(composed.missingSlots),
    });
    const seenTargets = new Set<string>();
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
    // P13 — record per-page bake target for the plugin render pass.
    bakeTargets.set(page.page_id, {
      pageId: page.page_id,
      slug: page.slug,
    });

    args.onProgress?.({ pagesDone: i + 1, pagesTotal: pageRows.length });
  }

  // A module whose content could not render (a broken nested ref, a
  // malformed list item, …) would ship as a silently empty section.
  // Refuse the build and name every page / module / field instead.
  assertNoRenderFailures(renderedForGate);
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
  timer.lap("compose");

  // P7 — media pass. Mutates each composedPages[i].html in place to
  // swap /_caelo/media/... URLs for /_assets/...; copies variant bytes
  // into the slug-based `_assets/` layout under content-hashed names
  // (`_assets/<slug>.<hash>.<ext>` for orig, `_assets/<slug>/<variant>.<hash>.<ext>`
  // for named variants, legacy id refs `_assets/<id>/<variant>.<hash>.<ext>`,
  // #667 — see media-asset-path.ts); emits the CDN manifest (always, even
  // when CDN copy is off — manifest is empty then). No-op when the build
  // references no media at all.
  // issue #150 — copy the resolved woff2 files into the build so the
  // @font-face URLs injected by the composer resolve on the deployed
  // site. Resolution happened before the compose loop (the CSS is part
  // of every page); the byte copy belongs here with the other output
  // passes.
  for (const f of themeFontFiles) {
    const target = join(buildDir, "_assets", "fonts", f.relPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(f.cachePath, target);
    fileCount += 1;
  }
  // A module may carry the editor preview's font URL (/_caelo/fonts/...),
  // which only the admin serves: point it at the copy above, or fail.
  rewritePreviewFontUrls(composedPages, new Set(themeFontFiles.map((f) => f.relPath)));

  const mediaSettings = await readMediaSettings(tx);
  const mediaRoot = resolve(root, process.env.MEDIA_ROOT_DIR ?? "data/media");
  await runMediaPass({
    tx,
    buildDir,
    pages: composedPages,
    mediaRoot,
    settings: mediaSettings,
  });
  // cdn_manifest.json is always written by runMediaPass.
  fileCount += 1;

  // P8 — SEO pass. Injects per-page <head> meta + canonical + JSON-LD
  // and emits sitemap.xml. Env-independent so promote can ship a staging
  // build verbatim; staging's noindex lives in robots.txt + the
  // X-Robots-Tag header (see seo-pass.ts header).
  // Mutates each composedPages[i].html in place, same pattern as
  // runMediaPass.
  timer.lap("media");
  const seoResult = await runSeoPass({
    tx,
    plugins: args.plugins,
    buildDir,
    mediaRoot,
    pages: composedPages,
    settings: seoSettings,
    pageUrlStyle,
    notFoundPageId,
  });
  if (seoResult.sitemapEmitted) fileCount += 1;
  timer.lap("seo");

  // P13 — plugin render pass: per page call each active
  // Tier-1 plugin's `staticRender(...)`, splice into the page body at
  // the matching `<div data-caelo-plugin="<slug>" ...>` placeholder.
  // Cache hits via static_bakes.cache_key skip the render entirely.
  await runPluginRenderPass({
    adapter: args.adapter,
    plugins: args.plugins,
    pages: composedPages,
    bakeTargets,
    pageUrlStyle,
  });

  timer.lap("plugin-render");
  // #449 — plugin client assets: one call per contributing plugin for
  // the whole build, written under `_caelo/plugin/<slug>/` with the
  // content hash in the name, then referenced from every page. Runs
  // AFTER the plugin render pass so a runtime that hydrates baked
  // markup is guaranteed to find it already in the document.
  const clientAssets = await args.plugins.collectBuildAssets(pageRows.map((p) => p.page_id));
  for (const asset of clientAssets) {
    const assetPath = resolve(buildDir, asset.relPath);
    if (!assetPath.startsWith(`${buildDir}/`)) {
      throw new Error(`static-generator: asset path "${asset.relPath}" escapes build directory`);
    }
    await mkdir(dirname(assetPath), { recursive: true });
    await writeFile(assetPath, asset.content, "utf8");
    fileCount += 1;
  }
  for (const p of composedPages) {
    p.html = injectPluginAssets(p.html, clientAssets, "linked");
  }

  // #605 — a plugin list-source section that survived composition means
  // the page would ship raw `{{#source}}` markers to visitors (the plugin
  // is off, or its answer never reached the build). Refuse the build and
  // name them.
  assertNoPluginMarkers(composedPages, await args.plugins.declaredListSourceNames());

  // issue #158 — minify the composer's inline CSS/JS last, after every
  // pass that still rewrites inside them (media URLs, plugin assets).
  timer.lap("plugin-assets");
  minifyPageAssets(composedPages);
  timer.lap("minify");

  // v0.2.85 — per-key Content-Type sidecar. When pageUrlStyle is
  // 'no-extension' the page files are bare slugs (no `.html`), so
  // the GCS publisher's extension-based contentTypeFor() lookup
  // would default to application/octet-stream. The sidecar declares
  // `<rel-path>` → `text/html; charset=utf-8` so the publisher
  // gets the right Content-Type without smuggling rules. Only
  // populated for files whose Content-Type can't be inferred from
  // the extension (no extension AND it's a page).
  const contentTypeOverrides: Record<string, string> = {};
  const pageDirs = new Set<string>();
  for (const p of composedPages) {
    const filePath = resolve(buildDir, p.relPath);
    if (!filePath.startsWith(`${buildDir}/`)) {
      throw new Error(`static-generator: output path "${p.relPath}" escapes build directory`);
    }
    pageDirs.add(dirname(filePath));
    if (target.pageUrlStyle === "no-extension" && !p.relPath.endsWith(".html")) {
      contentTypeOverrides[p.relPath] = "text/html; charset=utf-8";
    }
  }
  // #1003 — one mkdir per directory, then the files in parallel batches:
  // written one at a time this was seconds on a few thousand pages.
  await runBatched([...pageDirs], WRITE_PARALLELISM, async (dir) => {
    await mkdir(dir, { recursive: true });
  });
  await runBatched(composedPages, WRITE_PARALLELISM, async (p) => {
    await writeFile(resolve(buildDir, p.relPath), p.html, "utf8");
  });
  fileCount += composedPages.length;

  await writeFile(
    join(buildDir, "robots.txt"),
    buildRobotsTxtWithSitemap(
      target.robotsDefault,
      seoSettings.siteBaseUrl,
      seoResult.sitemapEmitted,
    ),
    "utf8",
  );
  fileCount += 1;

  const manifest = {
    target: target.name,
    env: target.env,
    runId,
    builtAt: new Date().toISOString(),
    pageCount: pageRows.length,
    pages: pageRows.map((p) => ({
      slug: p.slug,
      path: p.current_path,
      outputPath: outputPathOf(p),
    })),
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
  await writeFile(
    join(buildDir, "_content-types.json"),
    JSON.stringify(contentTypeOverrides, null, 2),
    "utf8",
  );
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

  timer.lap("write");
  // Atomic-ish swap. `current/` is a regular directory (not a symlink)
  // because Docker Desktop / VirtioFS bind mounts on macOS don't follow
  // symlinks reliably across the host/container boundary. We sync the
  // build dir's contents into `current/` in place — same files, same
  // dirs, the bind mount stays valid because the directory inode never
  // changes. The `builds/<runId>/` archive stays for content-addressed
  // history and for `deploy.rollback` to copy back when invoked.
  if (args.syncCurrent !== false) {
    await mkdir(currentLink, { recursive: true });
    await syncContents(buildDir, currentLink);
    timer.lap("sync-current");
  }

  // Best-effort old-build retention: keep the most recent 5, remove the
  // rest. Failures are swallowed because they don't affect the live
  // serving target (which is `current/`).
  await pruneOldBuilds(buildsDir, runId, 5);
  timer.lap("prune");

  return {
    pageCount: pageRows.length,
    fileCount,
    durationMs: Date.now() - start,
    phases: timer.phases(),
    buildDir,
    unpublishedLinkTargets,
  };
}

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

function groupModulesByBlock(rows: readonly ModuleRow[]): {
  blockName: string;
  modules: {
    moduleId: string;
    slug: string;
    displayName: string;
    html: string;
    css: string;
    js: string;
    fields?: ComposeField[];
    contentValues?: Record<string, unknown>;
    contentInstanceId?: string;
  }[];
}[] {
  const grouped = new Map<
    string,
    {
      moduleId: string;
      slug: string;
      displayName: string;
      html: string;
      css: string;
      js: string;
      fields?: ComposeField[];
      contentValues?: Record<string, unknown>;
      contentInstanceId?: string;
    }[]
  >();
  for (const r of rows) {
    const arr = grouped.get(r.block_name) ?? [];
    arr.push({
      moduleId: r.module_id,
      slug: r.slug,
      displayName: r.display_name,
      html: r.html,
      css: r.css,
      js: r.js,
      fields: parseModuleFields(r.fields),
      contentValues: parseContentValues(r.content_values),
      ...(r.variant ? {} : { contentInstanceId: r.content_instance_id }),
    });
    grouped.set(r.block_name, arr);
  }
  return [...grouped.entries()].map(([blockName, modules]) => ({ blockName, modules }));
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
