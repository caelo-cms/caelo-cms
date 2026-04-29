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
import { join, resolve } from "node:path";
import type { TransactionRunner } from "@caelo/query-api";
import { ComposeError, composePageWithLayout } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { readMediaSettings, runMediaPass } from "./media-pass.js";
import { buildRobotsTxtWithSitemap, readSeoSettings, runSeoPass } from "./seo-pass.js";

export interface DeployTarget {
  readonly id: string;
  readonly name: string;
  readonly env: "dev" | "staging" | "production";
  readonly outDir: string;
  readonly baseUrl: string;
  readonly robotsDefault: "index" | "noindex";
}

export interface GenerateResult {
  readonly pageCount: number;
  readonly fileCount: number;
  readonly durationMs: number;
  /** Absolute path to the build dir under builds/<runId>. */
  readonly buildDir: string;
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
  experiment_id: string | null;
  variant_label: string | null;
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
 */
export function pageOutputPath(slug: string): string {
  const trimmed = slug.replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === "home" || trimmed === "index") return "index.html";
  return `${trimmed}/index.html`;
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
}): Promise<GenerateResult> {
  const start = Date.now();
  const { tx, target, runId } = args;
  const root = args.repoRoot ?? process.cwd();
  const outDir = resolve(root, target.outDir);
  const buildsDir = join(outDir, "builds");
  const buildDir = join(buildsDir, runId);
  const currentLink = join(outDir, "current");

  await mkdir(buildDir, { recursive: true });

  const pageRows = (await tx.execute(sql`
    SELECT p.id::text AS page_id,
           p.slug, p.locale, p.title, p.status,
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
      AND p.status = 'published'
    ORDER BY p.slug ASC
  `)) as unknown as PageRow[];

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
           m.js          AS js
    FROM layout_modules lm JOIN modules m ON m.id = lm.module_id
    WHERE m.deleted_at IS NULL
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
    });
    perLayout.set(r.block_name, arr);
  }

  // P6.7.5 — load structured sets once for the whole build so each
  // page's composer gets the same theme + nav-menu state. Re-querying
  // per-page would be wasteful and could surface rebuild-mid-deploy
  // races where some pages saw the old menu and some the new.
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
  for (let i = 0; i < pageRows.length; i++) {
    const page = pageRows[i];
    if (!page) continue;
    const modRows = (await tx.execute(sql`
      SELECT pm.block_name, pm.position,
             m.id::text AS module_id,
             m.slug, m.display_name, m.html, m.css, m.js,
             NULL::uuid AS experiment_id,
             NULL::text AS variant_label
      FROM page_modules pm JOIN modules m ON m.id = pm.module_id
      WHERE pm.page_id = ${page.page_id}::uuid AND m.deleted_at IS NULL
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
    let composed: ReturnType<typeof composePageWithLayout>;
    try {
      composed = composePageWithLayout({
        templateHtml: page.template_html,
        templateCss: page.template_css,
        blocks,
        structuredSets,
        layoutHtml: page.layout_html,
        layoutCss: page.layout_css,
        layoutBlocks,
        layoutSlug: page.layout_slug,
      });
    } catch (e) {
      if (e instanceof ComposeError) {
        throw new Error(
          `static-generator: page slug=${page.slug} locale=${page.locale}: ${e.message}`,
        );
      }
      throw e;
    }

    composedPages.push({
      html: composed.html,
      pageSlug: page.slug,
      pageLocale: page.locale,
      pageTitle: page.title,
      relPath: pageOutputPath(page.slug),
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
  const mediaSettings = await readMediaSettings(tx);
  const mediaRoot = resolve(root, process.env["MEDIA_ROOT_DIR"] ?? "data/media");
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
  // same pattern as runMediaPass.
  const seoSettings = await readSeoSettings(tx);
  const seoResult = await runSeoPass({
    tx,
    buildDir,
    pages: composedPages,
    settings: seoSettings,
    envIsNoindex: target.robotsDefault === "noindex",
  });
  if (seoResult.sitemapEmitted) fileCount += 1;

  for (const p of composedPages) {
    const filePath = join(buildDir, p.relPath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, p.html, "utf8");
    fileCount += 1;
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
      outputPath: pageOutputPath(p.slug),
    })),
    variants: variantEntries,
  };
  await writeFile(
    join(buildDir, "routing-manifest.json"),
    JSON.stringify(manifest, null, 2),
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
    });
    grouped.set(r.block_name, arr);
  }
  return [...grouped.entries()].map(([blockName, modules]) => ({ blockName, modules }));
}
