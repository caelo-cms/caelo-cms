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
import { composePagePreview } from "@caelo/shared";
import { sql } from "drizzle-orm";

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
           t.css  AS template_css
    FROM pages p JOIN templates t ON t.id = p.template_id
    WHERE p.deleted_at IS NULL
      AND t.deleted_at IS NULL
      AND p.status = 'published'
    ORDER BY p.slug ASC
  `)) as unknown as PageRow[];

  let fileCount = 0;
  const variantEntries: VariantManifestEntry[] = [];
  args.onProgress?.({ pagesDone: 0, pagesTotal: pageRows.length });

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
    const composed = composePagePreview({
      templateHtml: page.template_html,
      templateCss: page.template_css,
      blocks,
    });

    const relPath = pageOutputPath(page.slug);
    const filePath = join(buildDir, relPath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, composed.html, "utf8");
    fileCount += 1;

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

  await writeFile(join(buildDir, "robots.txt"), buildRobotsTxt(target.robotsDefault), "utf8");
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
