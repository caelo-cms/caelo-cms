// SPDX-License-Identifier: MPL-2.0

/**
 * issue #195 — compose_from_run v2 against the real Postgres:
 *   - issue #253 (WS0): chrome binds ONCE at the LAYOUT — one shared
 *     header/footer module in layout_modules, ZERO per-page chrome
 *     placements, content-only imported templates;
 *   - one template per cluster, homepage cluster separate + first;
 *   - the cluster sample's page_css survives onto the template;
 *   - the design inventory (facts incl. gradient) lands on the run
 *     and in the output.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue195-compose",
};

const HOME_CSS = ".hero { background: linear-gradient(120deg, #7c2d12, #f59e0b); color: #fef3c7; }";
const BLOG_CSS = ".post { color: #1c1917; max-width: 65ch; }";

let runId: string;

/** Shared dev DB — leave no residue that trips sibling suites' FK
 *  cleanups (p14 deletes modules LIKE 'imported-%'). */
async function cleanupFixtures(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'issue195-%')`;
    await tx`DELETE FROM pages WHERE slug LIKE 'issue195-%'`;
    await tx`DELETE FROM content_instances WHERE module_id IN (
      SELECT id FROM modules WHERE slug LIKE 'imported-%'
    ) AND id NOT IN (SELECT content_instance_id FROM page_modules)`;
    await tx`DELETE FROM layout_modules WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE 'imported-%')`;
    await tx`DELETE FROM modules WHERE slug LIKE 'imported-%'
      AND id NOT IN (SELECT module_id FROM page_modules)`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE 'issue195-imported%')`;
    await tx`DELETE FROM templates WHERE slug LIKE 'issue195-imported%'`;
    await tx`DELETE FROM import_pages WHERE source_url LIKE 'https://issue195.example%'`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE 'https://issue195.example%'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL!);
  await cleanupFixtures();

  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: "https://issue195.example/",
    depth: 2,
    maxPages: 50,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  runId = (run.value as { runId: string }).runId;

  const chrome = [
    {
      blockName: "header",
      position: 0,
      html: "<header><nav>Issue195 Nav</nav></header>",
      displayName: "Header (imported)",
    },
    {
      blockName: "footer",
      position: 0,
      html: "<footer>© issue195</footer>",
      displayName: "Footer (imported)",
    },
  ];
  const content = (label: string) => ({
    blockName: "content",
    position: 0,
    html: `<section><h1>${label}</h1></section>`,
    displayName: `${label} section`,
  });
  const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      {
        sourceUrl: "https://issue195.example/",
        proposedSlug: "issue195-home",
        proposedTitle: "Home",
        proposedModules: [...chrome, content("Welcome")],
        proposedThemeTokens: { "color-primary": "#7c2d12" },
        signature: "home",
        pageCss: HOME_CSS,
      },
      {
        sourceUrl: "https://issue195.example/blog/a",
        proposedSlug: "issue195-blog-a",
        proposedTitle: "Post A",
        proposedModules: [...chrome, content("Post A")],
        proposedThemeTokens: { "color-primary": "#7c2d12" },
        signature: "/blog/*|x1",
        pageCss: BLOG_CSS,
      },
      {
        sourceUrl: "https://issue195.example/blog/b",
        proposedSlug: "issue195-blog-b",
        proposedTitle: "Post B",
        proposedModules: [...chrome, content("Post B")],
        proposedThemeTokens: { "color-primary": "#7c2d12" },
        signature: "/blog/*|x1",
        pageCss: BLOG_CSS,
      },
    ],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  // Label the blog cluster the way the chat flow would.
  const labelled = await execute(registry, adapter, SYSTEM, "imports.assign_page_cluster", {
    runId,
    clusterKey: "/blog/*|x1",
    label: "Blogartikel",
  });
  if (!labelled.ok) throw new Error(JSON.stringify(labelled.error));
  // ready_for_review so compose accepts the run.
  await execute(registry, adapter, SYSTEM, "imports.update_run_status", {
    runId,
    status: "ready_for_review",
    pagesSeen: 3,
    pagesExtracted: 3,
  });
});

afterAll(async () => {
  await cleanupFixtures();
  await sqlc.end();
  await adapter.close();
});

describe("compose_from_run v2 (#195)", () => {
  it("builds per-cluster templates with real chrome blocks + preserved css", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
      runId,
      templateSlug: "issue195-imported",
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const v = r.value as {
      templateId: string;
      templatesByCluster: Record<string, string>;
      pageIds: string[];
      homepageId: string | null;
      designInventory: string | null;
      layoutId: string;
      chromeBound: string[];
      chromeNotes: string[];
    };

    // One template per cluster; home separate; templateId = home's.
    expect(Object.keys(v.templatesByCluster).sort()).toEqual(["/blog/*|x1", "home"]);
    expect(v.templateId).toBe(v.templatesByCluster.home ?? "");
    expect(v.pageIds).toHaveLength(3);
    expect(v.homepageId).not.toBeNull();

    // Inventory carries the original's facts (gradient included).
    expect(v.designInventory).toContain("linear-gradient");
    expect(v.designInventory?.toLowerCase()).toContain("#7c2d12");

    const rows = (await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`
        SELECT p.slug, p.template_id::text AS template_id,
               pm.block_name, pm.sync_mode, pm.module_id::text AS module_id,
               t.css AS template_css, t.slug AS template_slug
        FROM pages p
        JOIN page_modules pm ON pm.page_id = p.id
        JOIN templates t ON t.id = p.template_id
        WHERE p.slug LIKE 'issue195-%'
        ORDER BY p.slug, pm.block_name
      `;
    })) as unknown as Array<{
      slug: string;
      template_id: string;
      block_name: string;
      sync_mode: string;
      module_id: string;
      template_css: string;
      template_slug: string;
    }>;

    // issue #253 (WS0): page bodies are content-only — chrome never
    // lands as a per-page placement.
    const homeBlocks = rows.filter((x) => x.slug === "issue195-home").map((x) => x.block_name);
    expect(homeBlocks.sort()).toEqual(["content"]);
    expect(rows.filter((x) => x.block_name === "header" || x.block_name === "footer")).toHaveLength(
      0,
    );

    // Chrome is ONE shared module per block, bound at the LAYOUT.
    expect([...v.chromeBound].sort()).toEqual(["footer", "header"]);
    expect(v.chromeNotes).toEqual([]);
    const layoutBinds = (await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`
        SELECT lm.block_name, count(*)::int AS n
        FROM layout_modules lm
        JOIN modules m ON m.id = lm.module_id
        WHERE lm.layout_id = ${v.layoutId}::uuid AND m.slug LIKE 'imported-%'
        GROUP BY lm.block_name
      `;
    })) as unknown as Array<{ block_name: string; n: number }>;
    expect(layoutBinds.map((x) => x.block_name).sort()).toEqual(["footer", "header"]);
    for (const b of layoutBinds) expect(b.n).toBe(1);

    // Cluster binding + css preservation.
    const homeRow = rows.find((x) => x.slug === "issue195-home");
    const blogRow = rows.find((x) => x.slug === "issue195-blog-a");
    expect(homeRow?.template_id).not.toBe(blogRow?.template_id);
    expect(homeRow?.template_css).toBe(HOME_CSS);
    expect(blogRow?.template_css).toBe(BLOG_CSS);
    // Cluster label drives the template slug.
    expect(blogRow?.template_slug).toBe("issue195-imported-blogartikel");
  });
});
