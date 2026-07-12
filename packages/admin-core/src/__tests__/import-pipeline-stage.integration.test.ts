// SPDX-License-Identifier: MPL-2.0

/**
 * Stage harness for the migration pipeline (speed-up plan, 2026-07-12).
 *
 * Every blocker the live searchviu mission hit past the crawl was a
 * DETERMINISTIC op bug (theme-merge junk vars, cluster mechanics,
 * compose) — none needed an AI or a live site to reproduce. This
 * harness replays a recorded slice of the real searchviu crawl
 * (fixtures/searchviu-import-pages.json.gz — home + blog pages, WP
 * preset junk vars included) through the real ops in seconds:
 *
 *   propose_run → update_run_status → write_extracted_pages
 *     → list_page_clusters → assign_page_cluster → compose_from_run
 *
 * Shared-state note: compose_from_run merges crawled tokens into the
 * ACTIVE theme. The CI database is per-job disposable and test files
 * run isolated (`bun test --isolate`); entities created here carry a
 * `svfx-` slug prefix and are deleted in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

interface FixturePage {
  source_url: string;
  proposed_slug: string;
  proposed_title: string;
  proposed_modules: { blockName: string; position: number; html: string; displayName: string }[];
  proposed_theme_tokens: Record<string, string>;
  structural_signature: string | null;
  page_css: string | null;
}

const FIXTURE: FixturePage[] = JSON.parse(
  gunzipSync(
    readFileSync(join(import.meta.dir, "fixtures", "searchviu-import-pages.json.gz")),
  ).toString(),
);

const PREFIX = "svfx-";
const ACTOR_EMAIL = "import-pipeline-harness@example.com";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let ctx: ExecutionContext;
let runId: string;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE to_path LIKE ${"/" + PREFIX + "%"}`;
      await tx`DELETE FROM pages WHERE slug LIKE ${PREFIX + "%"}`;
      // issue #253 — compose binds imported chrome into the shared
      // layout; unbind before deleting the modules themselves.
      await tx`DELETE FROM layout_modules WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${"imported-%"})`;
      await tx`DELETE FROM modules WHERE slug LIKE ${"imported-%"} AND slug NOT IN (SELECT m.slug FROM modules m JOIN page_modules pm ON pm.module_id = m.id)`;
      await tx`DELETE FROM templates WHERE slug LIKE ${PREFIX + "%"}`;
      await tx`DELETE FROM import_runs WHERE source_url = ${"https://svfx-harness.searchviu.example"}`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${ACTOR_EMAIL})`;
      await tx`DELETE FROM users WHERE email = ${ACTOR_EMAIL}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();

  // 0003 seeds the Caelo System actor — bootstrap a real user actor
  // from it (audit + proposed_by FKs need real rows on a fresh DB).
  const bootstrapCtx: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system",
    requestId: "pipeline-bootstrap",
  };
  const user = await execute(registry, adapter, bootstrapCtx, "users.create", {
    email: ACTOR_EMAIL,
    password: "pipeline-harness-pass",
    displayName: "Pipeline Harness",
    roleNames: [],
  });
  if (!user.ok) throw new Error(`users.create failed: ${user.error.kind}`);
  ctx = {
    actorId: (user.value as { userId: string }).userId,
    actorKind: "system",
    requestId: "pipeline-harness",
  };

  const proposed = await execute(registry, adapter, ctx, "imports.propose_run", {
    sourceUrl: "https://svfx-harness.searchviu.example",
    depth: 2,
    maxPages: 25,
  });
  if (!proposed.ok) throw new Error(`propose_run failed: ${proposed.error.kind}`);
  runId = (proposed.value as { runId: string }).runId;

  const wrote = await execute(registry, adapter, ctx, "imports.write_extracted_pages", {
    runId,
    pages: FIXTURE.map((p) => ({
      sourceUrl: p.source_url,
      proposedSlug: `${PREFIX}${p.proposed_slug}`.slice(0, 120),
      proposedTitle: p.proposed_title,
      proposedModules: p.proposed_modules,
      proposedThemeTokens: p.proposed_theme_tokens,
      ...(p.structural_signature ? { signature: p.structural_signature } : {}),
      ...(p.page_css ? { pageCss: p.page_css.slice(0, 600_000) } : {}),
    })),
  });
  if (!wrote.ok) throw new Error(`write_extracted_pages failed: ${wrote.error.kind}`);

  const status = await execute(registry, adapter, ctx, "imports.update_run_status", {
    runId,
    status: "ready_for_review",
    pagesSeen: FIXTURE.length,
    pagesExtracted: FIXTURE.length,
  });
  if (!status.ok) throw new Error(`update_run_status failed: ${status.error.kind}`);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("import pipeline stages (recorded searchviu crawl)", () => {
  it("clusters the recorded pages by structural shape", async () => {
    const r = await execute(registry, adapter, ctx, "imports.list_page_clusters", { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clusters = (r.value as { clusters: { clusterKey: string; count: number }[] }).clusters;
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters.reduce((n, c) => n + c.count, 0)).toBe(FIXTURE.length);
  });

  it("labels a cluster", async () => {
    const list = await execute(registry, adapter, ctx, "imports.list_page_clusters", { runId });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const first = (list.value as { clusters: { clusterKey: string }[] }).clusters[0];
    expect(first).toBeDefined();
    if (!first) return;
    const r = await execute(registry, adapter, ctx, "imports.assign_page_cluster", {
      runId,
      clusterKey: first.clusterKey,
      label: "Blog article",
    });
    expect(r.ok).toBe(true);
  });

  it("compose_from_run materialises pages despite WP preset junk tokens", async () => {
    // The fixture's proposed_theme_tokens carry the real site's
    // `--wp--preset--shadow--natural` (a CSS shadow string) — the
    // exact value that aborted the live run before the junk-var fix.
    expect(
      FIXTURE.some((p) =>
        Object.keys(p.proposed_theme_tokens).some((k) => k.includes("wp--preset")),
      ),
    ).toBe(true);

    const r = await execute(registry, adapter, ctx, "imports.compose_from_run", {
      runId,
      templateSlug: `${PREFIX}imported-page`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      pageIds: string[];
      templatesByCluster: Record<string, string>;
      themeTokensApplied: number;
      layoutId: string;
      chromeBound: string[];
      chromeNotes: string[];
    };
    expect(v.pageIds.length).toBe(FIXTURE.length);
    expect(Object.keys(v.templatesByCluster).length).toBeGreaterThanOrEqual(1);

    // issue #253 (WS0) — chrome binds ONCE at the layout; page bodies
    // are content-only. Pre-#253, compose duplicated the crawled
    // header/footer into per-page template blocks while the layout's
    // chrome slots rendered the loud-raw `_` on every page.
    expect([...v.chromeBound].sort()).toEqual(["footer", "header"]);
    expect(v.chromeNotes).toEqual([]);

    // Raw reads need the RLS actor GUC — every table forces RLS.
    const db = new SQL(ADMIN_URL!);
    try {
      const rows = await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const layoutBinds = (await tx`
          SELECT block_name, module_id::text AS module_id FROM layout_modules
          WHERE layout_id = ${v.layoutId}::uuid AND block_name IN ('header', 'footer')
        `) as { block_name: string; module_id: string }[];
        const chromeKinds = (await tx`
          SELECT kind FROM modules WHERE id IN (SELECT module_id FROM layout_modules WHERE layout_id = ${v.layoutId}::uuid AND block_name IN ('header', 'footer'))
        `) as { kind: string }[];
        const pageChrome = (await tx`
          SELECT count(*)::int AS n FROM page_modules
          WHERE page_id = ANY(${v.pageIds}::uuid[]) AND block_name IN ('header', 'footer')
        `) as { n: number }[];
        const tpls = (await tx`
          SELECT id::text AS id, html FROM templates WHERE id = ANY(${Object.values(v.templatesByCluster)}::uuid[])
        `) as { id: string; html: string }[];
        const tplChromeBlocks = (await tx`
          SELECT count(*)::int AS n FROM template_blocks
          WHERE template_id = ANY(${Object.values(v.templatesByCluster)}::uuid[]) AND name IN ('header', 'footer')
        `) as { n: number }[];
        return { layoutBinds, chromeKinds, pageChrome, tpls, tplChromeBlocks };
      });
      const { layoutBinds } = rows;
      expect(layoutBinds.map((b) => b.block_name).sort()).toEqual(["footer", "header"]);
      for (const m of rows.chromeKinds) expect(m.kind).toBe("chrome");

      // No composed page carries a per-page chrome placement.
      expect(rows.pageChrome[0]?.n).toBe(0);

      // Imported templates are content-only: no chrome slots in the
      // html, no chrome template_blocks.
      expect(rows.tpls.length).toBe(Object.values(v.templatesByCluster).length);
      for (const tpl of rows.tpls) {
        expect(tpl.html).not.toContain('caelo-slot name="header"');
        expect(tpl.html).not.toContain('caelo-slot name="footer"');
        expect(tpl.html).toContain('caelo-slot name="content"');
      }
      expect(rows.tplChromeBlocks[0]?.n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it("re-compose keeps chrome bound exactly once at the layout", async () => {
    // All pages are accepted after the previous test, so compose
    // refuses to re-run (idempotency contract) — and the layout
    // binding from the first compose stays single.
    const r = await execute(registry, adapter, ctx, "imports.compose_from_run", {
      runId,
      templateSlug: `${PREFIX}imported-page`,
    });
    expect(r.ok).toBe(false);

    const db = new SQL(ADMIN_URL!);
    try {
      const binds = await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return (await tx`
          SELECT block_name, count(*)::int AS n FROM layout_modules
          WHERE block_name IN ('header', 'footer')
            AND module_id IN (SELECT id FROM modules WHERE slug LIKE ${"imported-%"})
          GROUP BY block_name
        `) as { block_name: string; n: number }[];
      });
      expect(binds.length).toBe(2);
      for (const b of binds) expect(b.n).toBe(1);
    } finally {
      await db.end();
    }
  });
});
