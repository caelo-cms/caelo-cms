// SPDX-License-Identifier: MPL-2.0

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
 * Composition reuses `composePagePreview` from shared so preview and
 * production produce the same HTML byte-for-byte.
 */

import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  ComposeError,
  type ComposeFonts,
  type ComposeTheme,
  composePageWithLayout,
  fontUnresolvableMarker,
  type ModuleFieldKind,
  resolveLocaleUrl,
  type ThemeDocument,
  trimSlashes,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { defaultFontsCacheDir, resolveThemeFonts } from "./fonts-resolver.js";
import { readMediaSettings, runMediaPass } from "./media-pass.js";
import { type BakeTarget, runPluginRenderPass } from "./plugin-pass.js";
import { buildRobotsTxtWithSitemap, readSeoSettings, runSeoPass } from "./seo-pass.js";

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
  /** Absolute path to the build dir under builds/<runId>. */
  readonly buildDir: string;
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
  locale: string;
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
  experiment_id: string | null;
  variant_label: string | null;
}

/**
 * Parse the jsonb `modules.fields` column as it comes back from
 * `m.fields::text`. The shape is `[{ name, kind, label, default? }]`.
 * The substitution path needs `name`, `kind` (#71 — for text-list /
 * link-list / module-list dispatch via the shared template engine),
 * and `default`. Returns undefined when the column is null / empty
 * / malformed — caller treats that as "no field-default substitution
 * to do" rather than throwing, so a legacy module with a NULL fields
 * column still ships.
 */
function parseModuleFields(
  raw: string | null,
): { name: string; kind?: ModuleFieldKind; default?: unknown }[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const out: { name: string; kind?: ModuleFieldKind; default?: unknown }[] = [];
    for (const f of parsed) {
      if (!f || typeof f !== "object") continue;
      const o = f as { name?: unknown; kind?: unknown; default?: unknown };
      if (typeof o.name !== "string") continue;
      // The jsonb may carry an unknown / typo'd kind; the cast preserves
      // today's runtime behaviour (the engine emits kind-mismatch when
      // dispatch fails to find a matching branch), so propagating the
      // raw string as the union type is a deliberate lie that keeps
      // the fail-loud channel intact. Compile-time safety lives at the
      // callers (compose, preview-render) where `kind` originates from
      // typed authoring tools rather than raw jsonb.
      const kind = typeof o.kind === "string" ? (o.kind as ModuleFieldKind) : undefined;
      out.push({ name: o.name, kind, default: o.default });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the jsonb `content_instances.values` column. Per-placement
 * override map keyed by module field name — see
 * `applyFieldSubstitution` in `@caelo-cms/shared/preview-compose` for
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

interface VariantManifestEntry {
  pageSlug: string;
  locale: string;
  experimentId: string;
  variantLabel: string;
  outputPath: string;
}

/** Optional progress callback so the parent process can show pagesDone/total. */
export type ProgressCallback = (progress: { pagesDone: number; pagesTotal: number }) => void;

/**
 * Emits a stable file path for a published page. Slug "/" or "" or "home"
 * become `index.html`; everything else becomes `<slug>/index.html` so the
 * URL looks clean (no `.html` suffix served by static hosts).
 *
 * P9 review pass — when a locale config is supplied, the path is
 * shaped per CMS_REQUIREMENTS §7.2:
 *   - none         → `<slug>/index.html`              (no prefix)
 *   - subdirectory → `<code>/<slug>/index.html`       (`/de/about/`)
 *   - subdomain    → `_hosts/<urlHost>/<slug>/index.html`
 *   - domain       → `_hosts/<urlHost>/<slug>/index.html`
 *
 * The `_hosts/<host>/...` directory is the per-host emission tree the
 * deploy layer (P13/P14/P15) will hand each subdomain/domain its own
 * subtree. Without a locale config (back-compat, no-locale tests) the
 * function returns the original single-locale shape.
 */
export interface PageLocaleConfig {
  readonly code: string;
  readonly urlStrategy: "none" | "subdirectory" | "subdomain" | "domain";
  readonly urlHost: string | null;
}

export function pageOutputPath(
  slug: string,
  locale?: PageLocaleConfig,
  pageUrlStyle: "directory" | "no-extension" = "directory",
): string {
  const trimmed = trimSlashes(slug);
  const isHome = trimmed === "" || trimmed === "home" || trimmed === "index";
  // Home page stays at `index.html` regardless of style — the bucket
  // root must serve something for `/`, and browsers + GCS expect
  // index.html there. The home page's own canonical link points at
  // `/` so search engines consolidate /index.html → / either way.
  const file = isHome
    ? "index.html"
    : pageUrlStyle === "no-extension"
      ? trimmed
      : `${trimmed}/index.html`;
  if (!locale) return file;
  switch (locale.urlStrategy) {
    case "none":
      return file;
    case "subdirectory":
      return `${locale.code}/${file}`;
    case "subdomain":
    case "domain": {
      if (!locale.urlHost) {
        throw new Error(
          `pageOutputPath: locale '${locale.code}' urlStrategy='${locale.urlStrategy}' requires url_host`,
        );
      }
      return `_hosts/${locale.urlHost}/${file}`;
    }
  }
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
 * Scope mirrors `zeroPageBuildError`: full builds on non-dev targets. It
 * only fires when at least one page COULD have claimed the root (a page
 * whose locale has no URL prefix — strategy 'none' or no locale config);
 * an all-subdirectory/subdomain locale setup roots its locales elsewhere
 * and is not this guard's business.
 *
 * @returns the error message to throw, or null when the build may proceed.
 *   Pure so the guard is unit-testable without a DB.
 */
export function missingRootPageError(args: {
  /** Every emitted page path (relative, e.g. "index.html", "about/index.html"). */
  outputPaths: readonly string[];
  /** Slugs of pages whose locale would emit at the root level (no prefix). */
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
    "The homepage must use the slug 'home' (or 'index') to ship at '/'. " +
    "Rename the intended homepage's slug (AI: `update_pages_many` with slug 'home'; UI: the page's settings) and re-run the deploy. " +
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

export async function generateSite(args: {
  tx: TransactionRunner;
  target: DeployTarget;
  /** Stable id (deploy_runs.id) used as the build directory name. */
  runId: string;
  /** Optional repo root so out_dir resolves against it; defaults to cwd. */
  repoRoot?: string;
  /** Optional progress callback fired after each page is written. */
  onProgress?: ProgressCallback;
  /** P13 — adapter handle so the plugin render pass can read +
   *  upsert `static_bakes` outside the page-build transaction. When
   *  omitted the pass no-ops (e.g. dev preview). */
  adapter?: import("@caelo-cms/query-api").DatabaseAdapter;
  /** P13 ideas-pass — incremental rebuild whitelist. When non-empty,
   *  only re-bake the listed page ids; the rest are left alone in
   *  the build dir. Auto-redeploy passes the audit_events tail's
   *  touched page ids; manual triggers omit it for full rebuild. */
  changedPageIds?: ReadonlyArray<string>;
}): Promise<GenerateResult> {
  const start = Date.now();
  const { tx, target, runId } = args;
  const root = args.repoRoot ?? process.cwd();
  const outDir = resolve(root, target.outDir);
  const buildsDir = join(outDir, "builds");
  const buildDir = join(buildsDir, runId);
  const currentLink = join(outDir, "current");

  await mkdir(buildDir, { recursive: true });

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
    args.changedPageIds && args.changedPageIds.length > 0
      ? sql.raw(` AND p.id = ANY(${uuidArrayLiteral(args.changedPageIds)}::uuid[])`)
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
           p.slug, p.locale, p.title, p.status,
           p.content_hash AS content_hash,
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
  `)) as unknown as Array<PageRow & { content_hash: string | null }>;

  const zeroPageError = zeroPageBuildError({
    pageCount: pageRows.length,
    env: target.env,
    incremental: (args.changedPageIds?.length ?? 0) > 0,
  });
  if (zeroPageError !== null) throw new Error(zeroPageError);

  // P9 review pass — load the locale registry so the emitter can shape
  // file paths per (slug, locale) instead of slug alone. Otherwise two
  // pages with the same slug but different locales collide on
  // index.html. Throws loudly (no-fallbacks) if a page references a
  // locale that isn't in the registry.
  const localeRows = (await tx.execute(sql`
    SELECT code, url_strategy, url_host FROM locales
  `)) as unknown as {
    code: string;
    url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
    url_host: string | null;
  }[];
  const localeByCode = new Map<string, PageLocaleConfig>(
    localeRows.map((r) => [
      r.code,
      { code: r.code, urlStrategy: r.url_strategy, urlHost: r.url_host },
    ]),
  );

  // issue #302 — fail loudly when no page will land at the bucket root.
  const plannedPaths = pageRows.map((p) =>
    pageOutputPath(p.slug, localeByCode.get(p.locale), target.pageUrlStyle),
  );
  const rootEligibleSlugs = pageRows
    .filter((p) => {
      const cfg = localeByCode.get(p.locale);
      return cfg === undefined || cfg.urlStrategy === "none";
    })
    .map((p) => p.slug);
  const rootError = missingRootPageError({
    outputPaths: plannedPaths,
    rootEligibleSlugs,
    env: target.env,
    incremental: (args.changedPageIds?.length ?? 0) > 0,
  });
  if (rootError !== null) throw new Error(rootError);

  // P6.7.6 — load layout modules once for the whole build, keyed by
  // layout_id. Per-page composition picks its layout's set; same
  // rationale as structured sets above.
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
        fields?: { name: string; kind?: ModuleFieldKind; default?: unknown }[];
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

  // P6.7.5 — load structured sets once for the whole build so each
  // page's composer gets the same nav-menu state. Re-querying per-page
  // would be wasteful and could surface rebuild-mid-deploy races where
  // some pages saw the old menu and some the new.
  // v0.11.0 (#45) — theme moved out of structured_sets into its own
  // `themes` table; loaded separately below as a ComposeTheme.
  const setRows = (await tx.execute(sql`
    SELECT kind, slug, items::text AS items FROM structured_sets
  `)) as unknown as { kind: string; slug: string; items: string }[];
  const structuredSets = { byKindSlug: {} as Record<string, unknown[]> };
  for (const r of setRows) {
    try {
      structuredSets.byKindSlug[`${r.kind}/${r.slug}`] = JSON.parse(r.items) as unknown[];
    } catch {
      // ignore malformed rows
    }
  }

  // v0.11.0 — load the active theme once for the whole build. The
  // renderer emits <style data-source="theme"> from these tokens; the
  // four asset URLs are surfaced for modules that reference them.
  const themeRows = (await tx.execute(sql`
    SELECT
      tokens                       AS tokens,
      logo_media_id::text          AS logo_media_id,
      logo_dark_media_id::text     AS logo_dark_media_id,
      favicon_media_id::text       AS favicon_media_id,
      social_share_media_id::text  AS social_share_media_id
    FROM themes WHERE is_active = true LIMIT 1
  `)) as unknown as Array<{
    tokens: unknown;
    logo_media_id: string | null;
    logo_dark_media_id: string | null;
    favicon_media_id: string | null;
    social_share_media_id: string | null;
  }>;
  let activeTheme: ComposeTheme | undefined;
  const tr = themeRows[0];
  if (tr) {
    const tokens: ThemeDocument =
      typeof tr.tokens === "string"
        ? (JSON.parse(tr.tokens) as ThemeDocument)
        : (tr.tokens as ThemeDocument);
    const asset = (id: string | null): { mediaId: string; url: string } | null =>
      id === null ? null : { mediaId: id, url: buildMediaUrl(id, "orig") };
    activeTheme = {
      tokens,
      assets: {
        logo: asset(tr.logo_media_id),
        logoDark: asset(tr.logo_dark_media_id),
        favicon: asset(tr.favicon_media_id),
        socialShare: asset(tr.social_share_media_id),
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
    const resolved = await resolveThemeFonts({
      tokens: activeTheme.tokens,
      cacheDir: defaultFontsCacheDir(root),
      publicBasePath: "/_assets/fonts",
    });
    if (resolved.unresolved.length > 0) {
      throw new Error(
        `static-generator: ${resolved.unresolved.map(fontUnresolvableMarker).join(", ")} — ` +
          "the active theme names web fonts that could not be fetched/parsed. " +
          "Fix the typography tokens (set_theme_tokens) or restore access to the fonts source, then redeploy.",
      );
    }
    if (resolved.files.length > 0) {
      themeFonts = { css: resolved.css, preloads: resolved.preloads };
      themeFontFiles = resolved.files;
    }
  }

  // P9 — build the per-slug published-locale matrix once so the
  // language-selector renderer can list cross-locale URLs without a
  // per-page round-trip. Same shape the seo-pass hreflang block uses.
  const seoSettings = await readSeoSettings(tx);
  // v0.9.9 — matches the main-query filter above. Stage ≡ Production
  // so the hreflang language-selector matrix is also published-only on
  // both deploy targets. Dev keeps the no-filter shape (debugging).
  const slugStatusFilter =
    target.env === "dev" ? sql.raw("") : sql.raw(" AND status = 'published'");
  const slugLocaleRows = (await tx.execute(sql`
    SELECT slug, locale FROM pages
    WHERE deleted_at IS NULL ${slugStatusFilter}
  `)) as unknown as { slug: string; locale: string }[];
  const localesBySlug = new Map<string, string[]>();
  for (const r of slugLocaleRows) {
    const arr = localesBySlug.get(r.slug) ?? [];
    arr.push(r.locale);
    localesBySlug.set(r.slug, arr);
  }

  let fileCount = 0;
  const variantEntries: VariantManifestEntry[] = [];
  args.onProgress?.({ pagesDone: 0, pagesTotal: pageRows.length });

  // Compose pages first (in memory), then run the media pass to
  // rewrite /_caelo/media/... URLs and copy variant bytes into
  // _assets/, then write the per-page HTML files. Two-pass keeps the
  // media-pass deduped across pages — every (asset, variant) pair is
  // copied once even when 50 pages reference it.
  const composedPages: {
    html: string;
    pageSlug: string;
    pageLocale: string;
    pageTitle: string;
    relPath: string;
  }[] = [];
  // P13 — per-(slug, locale) bake target for the plugin render pass.
  const bakeTargets = new Map<string, BakeTarget>();
  for (let i = 0; i < pageRows.length; i++) {
    const page = pageRows[i];
    if (!page) continue;
    const modRows = (await tx.execute(sql`
      SELECT pm.block_name, pm.position,
             m.id::text AS module_id,
             m.slug, m.display_name, m.html, m.css, m.js, m.fields::text AS fields,
             ci.values::text AS content_values,
             NULL::uuid AS experiment_id,
             NULL::text AS variant_label
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

    const blocks = groupModulesByBlock(modRows);
    const layoutBlocksMap = layoutModulesByLayout.get(page.layout_id);
    const layoutBlocks =
      layoutBlocksMap === undefined
        ? []
        : [...layoutBlocksMap.entries()].map(([blockName, modules]) => ({
            blockName,
            modules,
          }));
    // P6.7.6 — composer throws ComposeError on layout misconfiguration
    // (e.g. layout HTML missing the required `content` slot). Surface
    // it with the page slug so the deploy operator can locate the
    // offending row, rather than silently emitting a body-less page.
    // P9 — build the per-page languageSelector context. Lists every
    // locale that has a published variant of this page's slug; the
    // composer renders a `<nav>` of `<a>` rows when a module's slug
    // starts with `language-selector-`. Empty when the page is the
    // only published variant.
    const pageLocaleSiblings = localesBySlug.get(page.slug) ?? [];
    const availableLocales = pageLocaleSiblings
      .map((code) => {
        const cfg = localeByCode.get(code);
        if (!cfg) return null;
        try {
          return {
            code,
            displayName: cfg.code,
            href: resolveLocaleUrl(
              {
                code: cfg.code,
                displayName: cfg.code,
                urlStrategy: cfg.urlStrategy,
                urlHost: cfg.urlHost,
                isDefault: false,
              },
              page.slug,
              seoSettings.siteBaseUrl,
            ),
            isCurrent: code === page.locale,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    let composed: ReturnType<typeof composePageWithLayout>;
    try {
      composed = composePageWithLayout({
        templateHtml: page.template_html,
        templateCss: page.template_css,
        blocks,
        structuredSets,
        theme: activeTheme,
        fonts: themeFonts,
        layoutHtml: page.layout_html,
        layoutCss: page.layout_css,
        layoutBlocks,
        layoutSlug: page.layout_slug,
        languageSelector: { availableLocales },
      });
    } catch (e) {
      if (e instanceof ComposeError) {
        throw new Error(
          `static-generator: page slug=${page.slug} locale=${page.locale}: ${e.message}`,
        );
      }
      throw e;
    }

    const pageLocaleCfg = localeByCode.get(page.locale);
    if (!pageLocaleCfg) {
      throw new Error(
        `static-generator: page slug=${page.slug} references locale='${page.locale}' which is not in the locales registry — deploy aborted (no-fallbacks)`,
      );
    }
    composedPages.push({
      html: composed.html,
      pageSlug: page.slug,
      pageLocale: page.locale,
      pageTitle: page.title,
      relPath: pageOutputPath(page.slug, pageLocaleCfg, target.pageUrlStyle),
    });
    // P13 — record per-page bake target for the plugin render pass.
    bakeTargets.set(`${page.slug}:${page.locale}`, {
      pageId: page.page_id,
      slug: page.slug,
      locale: page.locale,
      contentHash: page.content_hash ?? "",
    });

    // A/B variant emission hook: when modules carry experiment_id +
    // variant_label (P4 schema columns, P12A populates), the generator
    // emits each variant under module/<id>/<label>.html and records it
    // in the routing manifest so the edge layer (P13/P15) can split.
    // P6 leaves the columns NULL, so this loop is a no-op for now —
    // the wiring is in place to be activated without a generator change.
    for (const m of modRows) {
      if (m.experiment_id && m.variant_label) {
        const variantPath = `module/${m.module_id}/${m.variant_label}.html`;
        await mkdir(join(buildDir, "module", m.module_id), { recursive: true });
        await writeFile(join(buildDir, variantPath), m.html, "utf8");
        fileCount += 1;
        variantEntries.push({
          pageSlug: page.slug,
          locale: page.locale,
          experimentId: m.experiment_id,
          variantLabel: m.variant_label,
          outputPath: variantPath,
        });
      }
    }
    args.onProgress?.({ pagesDone: i + 1, pagesTotal: pageRows.length });
  }

  // P7 — media pass. Mutates each composedPages[i].html in place to
  // swap /_caelo/media/... URLs for /_assets/...; copies variant bytes
  // into <buildDir>/_assets/<asset-id>/<variant>.<ext>; emits the CDN
  // manifest (always, even when CDN copy is off — manifest is empty
  // then). No-op when the build references no media at all.
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
  // + hreflang. Emits sitemap.xml when site_defaults.sitemap_enabled
  // is on AND the env isn't noindex (staging stays out of the
  // sitemap regardless). Mutates each composedPages[i].html in place,
  // same pattern as runMediaPass. seoSettings was hoisted earlier so
  // the language-selector renderer can share the same siteBaseUrl.
  const seoResult = await runSeoPass({
    tx,
    buildDir,
    pages: composedPages,
    settings: seoSettings,
    envIsNoindex: target.robotsDefault === "noindex",
    pageUrlStyle: target.pageUrlStyle,
  });
  if (seoResult.sitemapEmitted) fileCount += 1;

  // P13 — plugin render pass: per (page, locale) call each active
  // Tier-1 plugin's `staticRender(...)`, splice into the page body at
  // the matching `<div data-caelo-plugin="<slug>" ...>` placeholder.
  // Cache hits via static_bakes.cache_key skip the render entirely.
  // Skipped when no adapter is supplied (dev preview path).
  if (args.adapter) {
    await runPluginRenderPass({
      adapter: args.adapter,
      pages: composedPages,
      bakeTargets,
    });
  }

  // v0.2.85 — per-key Content-Type sidecar. When pageUrlStyle is
  // 'no-extension' the page files are bare slugs (no `.html`), so
  // the GCS publisher's extension-based contentTypeFor() lookup
  // would default to application/octet-stream. The sidecar declares
  // `<rel-path>` → `text/html; charset=utf-8` so the publisher
  // gets the right Content-Type without smuggling rules. Only
  // populated for files whose Content-Type can't be inferred from
  // the extension (no extension AND it's a page).
  const contentTypeOverrides: Record<string, string> = {};
  for (const p of composedPages) {
    const filePath = join(buildDir, p.relPath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, p.html, "utf8");
    fileCount += 1;
    if (target.pageUrlStyle === "no-extension" && !p.relPath.endsWith(".html")) {
      contentTypeOverrides[p.relPath] = "text/html; charset=utf-8";
    }
  }

  // P13 audit fix #1 — variant file emission for active experiments.
  // The /api/variant.js script fetches `/_variants/<exp>__<variant><page>`
  // and replaces <main>. Without this loop those URLs 404 in real use.
  // For P13 the per-variant body is the same composed page (placeholder
  // for per-variant module overrides — those land with the typed-content
  // / kits work in P12A). The file existing means the script's swap
  // succeeds + analytics impressions accumulate.
  const experimentRows = (await tx.execute(sql`
    SELECT id::text AS id, slug, page_id::text AS page_id, variants
    FROM experiments
    WHERE status = 'active'
  `)) as unknown as Array<{
    id: string;
    slug: string;
    page_id: string;
    variants: Array<{
      label: string;
      weight: number;
      // P13 ideas-pass — optional per-variant string substitutions
      // applied to the composed page HTML before emission. Empty/absent
      // = identical body (just file existence for routing).
      htmlPatches?: Array<{ find: string; replace: string }>;
    }>;
  }>;
  if (experimentRows.length > 0) {
    // Build a lookup: page_id → composed page (the source of variant HTML).
    const pageById = new Map<string, (typeof composedPages)[number]>();
    for (const cp of composedPages) {
      const t = bakeTargets.get(`${cp.pageSlug}:${cp.pageLocale}`);
      if (t) pageById.set(t.pageId, cp);
    }
    for (const e of experimentRows) {
      const cp = pageById.get(e.page_id);
      if (!cp) continue;
      // P13 audit re-pass — for subdomain/domain locales the relPath
      // begins with `_hosts/<host>/...`. Emit the variant UNDER the
      // host root so the client-side `/_variants/...` fetch resolves
      // against the visitor's host (the script doesn't know about
      // _hosts/). For no-prefix / subdirectory locales, drop straight
      // under buildDir/_variants/.
      const HOSTS_PREFIX = /^_hosts\/([^/]+)\/(.*)$/;
      const m = HOSTS_PREFIX.exec(cp.relPath);
      const variantBaseDir = m ? `_hosts/${m[1]}/_variants` : "_variants";
      const pageRelToHost = m ? (m[2] ?? "") : cp.relPath;
      for (const v of e.variants) {
        const variantPath = `${variantBaseDir}/${e.slug}__${v.label}/${pageRelToHost}`;
        const fullPath = join(buildDir, variantPath);
        await mkdir(join(fullPath, ".."), { recursive: true });
        // P13 ideas-pass — apply htmlPatches if present so variants
        // actually differ in content. Each patch is a literal string
        // replace (no regex; no escaping needed). Order matters when
        // patches overlap; we apply in array order.
        let variantHtml = cp.html;
        for (const p of v.htmlPatches ?? []) {
          variantHtml = variantHtml.split(p.find).join(p.replace);
        }
        await writeFile(fullPath, variantHtml, "utf8");
        fileCount += 1;
      }
    }
  }

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
      locale: p.locale,
      outputPath: pageOutputPath(p.slug, localeByCode.get(p.locale), target.pageUrlStyle),
    })),
    variants: variantEntries,
  };
  await writeFile(
    join(buildDir, "routing-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  fileCount += 1;

  // P15 hot-fix #1 — emit a SEPARATE A/B routing manifest for the edge
  // routers. Filename intentionally distinct from `routing-manifest.json`
  // (the deploy manifest above) because the two have different shapes
  // and audiences:
  //   - routing-manifest.json: deploy provenance (target/env/runId/pages)
  //     consumed by the deploy ops + admin UI to verify what shipped.
  //   - ab-routing.json: per-page experiment routing consumed by the
  //     edge routers (P15 GCP/AWS/Azure stacks + P13 self-hosted Caddy
  //     gateway). Shape matches @caelo-cms/edge-router's RoutingManifest.
  // Variants reference the SAME file paths the static-gen wrote above
  // (the `_variants/<exp-slug>__<label>/<page>` shape) so the edge
  // routers' rewrite targets actually resolve.
  const pageSlugById = new Map<string, string>();
  for (const cp of composedPages) {
    const t = bakeTargets.get(`${cp.pageSlug}:${cp.pageLocale}`);
    if (t) pageSlugById.set(t.pageId, cp.pageSlug);
  }
  const abExperiments: Array<{
    pageSlug: string;
    experimentId: string;
    variants: Array<{ label: string; weight: number; path: string }>;
  }> = [];
  for (const e of experimentRows) {
    const slug = pageSlugById.get(e.page_id);
    if (!slug) continue;
    abExperiments.push({
      pageSlug: `/${slug}`,
      experimentId: e.id,
      variants: e.variants.map((v) => ({
        label: v.label,
        weight: v.weight,
        // Control variant (first one) keeps the original path; non-control
        // variants point at the per-experiment file the loop above wrote
        // under `<buildDir>/_variants/<exp-slug>__<label>/<slug>/index.html`.
        path: v === e.variants[0] ? `/${slug}` : `/_variants/${e.slug}__${v.label}/${slug}`,
      })),
    });
  }
  const abRoutingManifest = {
    // Use runId as manifestVersion — bumps every deploy so a fresh
    // bucketing rolls out atomically when operators want to re-randomize.
    manifestVersion: runId,
    experiments: abExperiments,
  };
  await writeFile(
    join(buildDir, "ab-routing.json"),
    JSON.stringify(abRoutingManifest, null, 2),
    "utf8",
  );
  fileCount += 1;

  // P6.7.5 — emit a Caddy redirects snippet from the `redirects` table.
  // The Caddy hosts at :8081 / :8082 (P6.1) `import` this file, so a
  // build always carries the latest 301 set. The hooks-server fallback
  // (admin) consults the table directly, so dev / smoke environments
  // get the same behaviour without Caddy running.
  const redirectRows = (await tx.execute(sql`
    SELECT from_path, to_path, status_code FROM redirects
    ORDER BY from_path
  `)) as unknown as { from_path: string; to_path: string; status_code: number }[];
  const redirectsCaddy = [
    "# Auto-generated by Caelo static-generator. Do not edit by hand.",
    ...redirectRows.map((r) => `redir ${r.from_path} ${r.to_path} ${r.status_code}`),
    "",
  ].join("\n");
  await writeFile(join(buildDir, "_redirects.caddy"), redirectsCaddy, "utf8");
  fileCount += 1;

  // P8 — emit additional formats so per-provider Pulumi adapters
  // (P15) can pick the one their CDN consumes. Authors don't need
  // to switch — the same redirects table drives all formats.
  // Netlify: `<from> <to> <status>` per line.
  const redirectsNetlify = [
    "# Auto-generated by Caelo static-generator. Do not edit by hand.",
    ...redirectRows.map((r) => `${r.from_path} ${r.to_path} ${r.status_code}`),
    "",
  ].join("\n");
  await writeFile(join(buildDir, "_redirects"), redirectsNetlify, "utf8");
  fileCount += 1;
  // Cloudflare Pages: `<from> <to> <status>` per line, same as
  // Netlify — file lives at `_redirects` already so we just symlink-
  // equivalent: write a second Cloudflare-named copy as a hint to
  // operators of which file they need. The same content works for
  // either CDN host.
  await writeFile(join(buildDir, "_redirects.cloudflare"), redirectsNetlify, "utf8");
  fileCount += 1;

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

  // Atomic-ish swap. `current/` is a regular directory (not a symlink)
  // because Docker Desktop / VirtioFS bind mounts on macOS don't follow
  // symlinks reliably across the host/container boundary. We sync the
  // build dir's contents into `current/` in place — same files, same
  // dirs, the bind mount stays valid because the directory inode never
  // changes. The `builds/<runId>/` archive stays for content-addressed
  // history and for `deploy.rollback` to copy back when invoked.
  await mkdir(currentLink, { recursive: true });
  await syncContents(buildDir, currentLink);

  // Best-effort old-build retention: keep the most recent 5, remove the
  // rest. Failures are swallowed because they don't affect the live
  // serving target (which is `current/`).
  await pruneOldBuilds(buildsDir, runId, 5);

  return { pageCount: pageRows.length, fileCount, durationMs: Date.now() - start, buildDir };
}

/**
 * Mirror `src` into `dst` so dst contains exactly src's tree. Files are
 * overwritten in place; files in dst not present in src are removed.
 * Empty subdirectories are pruned bottom-up. Tolerates EFAULT on rm
 * (Docker Desktop quirk on rm-inside-bind-mount on macOS) so a build
 * never fails the whole deploy because a stale child couldn't be
 * unlinked.
 */
async function syncContents(src: string, dst: string): Promise<void> {
  const tryRm = async (path: string, opts: Parameters<typeof rm>[1] = {}) => {
    try {
      await rm(path, opts);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EFAULT" && code !== "ENOENT") throw e;
    }
  };
  const srcFiles = new Set<string>();
  const collect = async (rel: string): Promise<void> => {
    const entries = await readdir(join(src, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await collect(childRel);
      else srcFiles.add(childRel);
    }
  };
  await collect("");
  for (const rel of srcFiles) {
    await mkdir(join(dst, rel, ".."), { recursive: true });
    await copyFile(join(src, rel), join(dst, rel));
  }
  const sweep = async (rel: string): Promise<void> => {
    const here = join(dst, rel);
    if (!(await stat(here).catch(() => null))) return;
    const entries = await readdir(here, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await sweep(childRel);
        const remaining = await readdir(join(dst, childRel)).catch(() => []);
        if (remaining.length === 0) await tryRm(join(dst, childRel), { recursive: false });
      } else if (!srcFiles.has(childRel)) {
        await tryRm(join(dst, childRel), { force: true });
      }
    }
  };
  await sweep("");
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
    fields?: { name: string; kind?: ModuleFieldKind; default?: unknown }[];
    contentValues?: Record<string, unknown>;
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
      fields?: { name: string; kind?: ModuleFieldKind; default?: unknown }[];
      contentValues?: Record<string, unknown>;
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
    });
    grouped.set(r.block_name, arr);
  }
  return [...grouped.entries()].map(([blockName, modules]) => ({ blockName, modules }));
}
