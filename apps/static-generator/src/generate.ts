// SPDX-License-Identifier: MPL-2.0

/**
 * Static generator entry point. Takes a transaction handle on `cms_admin`
 * plus a `DeployTarget` and emits one HTML file per published page into
 * `target.outDir`, plus `robots.txt` and `routing-manifest.json`.
 *
 * Pure function over data: no IO except file writes. Composition reuses
 * `composePagePreview` from admin-core so preview and production produce
 * the same HTML byte-for-byte.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
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
  /** Optional repo root so out_dir resolves against it; defaults to cwd. */
  repoRoot?: string;
}): Promise<GenerateResult> {
  const start = Date.now();
  const { tx, target } = args;
  const root = args.repoRoot ?? process.cwd();
  const outDir = resolve(root, target.outDir);

  // Write into outDir without a wipe. Two reasons:
  //   1. Bind-mounted serving containers (Caddy in compose) lose track
  //      of the directory contents on macOS Docker Desktop / VirtioFS
  //      after a rapid rm-then-recreate cycle. Stale-file accumulation
  //      is preferable to a serving layer that 404s after every deploy.
  //   2. Production deploys generally re-publish the same page slugs,
  //      so writes overwrite in place. Stale entries for deleted pages
  //      are pruned by the post-write reconciliation below.
  await mkdir(outDir, { recursive: true });
  const writtenFiles = new Set<string>();

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

  for (const page of pageRows) {
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
    const filePath = join(outDir, relPath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, composed.html, "utf8");
    writtenFiles.add(relPath);
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
        await mkdir(join(outDir, "module", m.module_id), { recursive: true });
        await writeFile(join(outDir, variantPath), m.html, "utf8");
        writtenFiles.add(variantPath);
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
  }

  await writeFile(join(outDir, "robots.txt"), buildRobotsTxt(target.robotsDefault), "utf8");
  writtenFiles.add("robots.txt");
  fileCount += 1;

  const manifest = {
    target: target.name,
    env: target.env,
    builtAt: new Date().toISOString(),
    pageCount: pageRows.length,
    variants: variantEntries,
  };
  await writeFile(join(outDir, "routing-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writtenFiles.add("routing-manifest.json");
  fileCount += 1;

  // Reconcile: prune anything in outDir we did not write this run. We
  // delete files individually (not the parent directory) so the bind
  // mount inode stays stable, then sweep empty dirs bottom-up.
  await pruneStaleFiles(outDir, writtenFiles);

  return { pageCount: pageRows.length, fileCount, durationMs: Date.now() - start };
}

async function pruneStaleFiles(outDir: string, written: ReadonlySet<string>): Promise<void> {
  // macOS Docker Desktop's VirtioFS occasionally returns EFAULT on `rm`
  // calls against paths visible inside an active bind mount. Stale
  // files staying behind on disk is preferable to a hard build failure
  // — they just accumulate slowly and don't break serving (Caddy 404s
  // anything we didn't write fresh because URLs map to live pages).
  const tryRm = async (path: string, opts: Parameters<typeof rm>[1] = {}) => {
    try {
      await rm(path, opts);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EFAULT" && code !== "ENOENT") throw e;
    }
  };
  const walk = async (rel: string): Promise<void> => {
    const abs = join(outDir, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel);
        const remaining = await readdir(join(outDir, childRel)).catch(() => []);
        if (remaining.length === 0) await tryRm(join(outDir, childRel), { recursive: false });
      } else if (!written.has(childRel)) {
        await tryRm(join(outDir, childRel), { force: true });
      }
    }
  };
  await walk("");
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
