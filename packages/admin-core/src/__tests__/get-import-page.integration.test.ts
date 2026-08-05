// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 — `get_import_page` + `imports.get_page_gist`. The migrate flow
 * rebuilds every crawled page with build_page, so it reads the STORED crawl
 * content as the gist — Markdown + tokens + a screenshot handle — and NEVER
 * the raw page-builder HTML. This proves the no-raw-HTML contract against a
 * real Postgres (§6): the op returns the assembled source HTML to the tool
 * layer, but the tool surfaces only Markdown/tokens/pageRef to the model, with
 * the source's Elementor classes stripped.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { getPageInspection } from "../ai/tools/_page-inspection-cache.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { getImportPageTool } from "../ai/tools/get-import-page.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const ACTOR_ID = "a1500000-0000-4000-8000-0000000a1500";
const RUN_ID = "a1510000-0000-4000-8000-0000000a1510";
const PAGE_ID = "a1520000-0000-4000-8000-0000000a1520";

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "get-import-page-test",
};

// The raw crawled module — page-builder div-soup the tool must NEVER surface.
const RAW_HTML =
  '<div class="elementor-widget elementor-element-abc123" data-elementor-type="wp-page" data-id="abc123">' +
  "<h1>Our Pricing</h1><p>Simple plans for growing teams.</p>" +
  '<ul class="elementor-list"><li>Starter</li><li>Pro</li></ul></div>';

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function seed(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_runs WHERE id = ${RUN_ID}::uuid`;
      await tx`
        INSERT INTO actors (id, kind, display_name)
        VALUES (${ACTOR_ID}::uuid, 'ai', 'gist test AI')
        ON CONFLICT (id) DO NOTHING`;
      await tx`
        INSERT INTO import_runs (id, source_url, proposed_by, status)
        VALUES (${RUN_ID}::uuid, 'https://gist.test/', ${ACTOR_ID}::uuid, 'ready_for_review')`;
      const modules = JSON.stringify([
        { blockName: "content", position: 0, html: RAW_HTML, displayName: "Body (imported)" },
      ]);
      await tx`
        INSERT INTO import_pages
          (id, run_id, source_url, proposed_slug, proposed_title,
           proposed_modules, proposed_theme_tokens, screenshot_object_key)
        VALUES (${PAGE_ID}::uuid, ${RUN_ID}::uuid, 'https://gist.test/pricing',
                'pricing', 'Pricing',
                ${modules}::jsonb,
                ${'{"color-primary":"#ff2244","font-body":"Inter"}'}::jsonb,
                'crawl/shot-abc.png')`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await seed();
});

afterAll(async () => {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_runs WHERE id = ${RUN_ID}::uuid`;
    });
  } finally {
    await sql.end();
  }
  await adapter.close();
});

describe("imports.get_page_gist + get_import_page tool", () => {
  it("op returns the assembled source HTML + slug/title/tokens/screenshot to the tool layer", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.get_page_gist", {
      importPageId: PAGE_ID,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const g = r.value as {
      proposedSlug: string;
      proposedTitle: string;
      html: string;
      themeTokens: Record<string, string>;
      screenshotObjectKey: string | null;
    };
    expect(g.proposedSlug).toBe("pricing");
    expect(g.proposedTitle).toBe("Pricing");
    // The op DOES carry the raw HTML — it is the tool's job to strip it.
    expect(g.html).toContain("Our Pricing");
    expect(g.themeTokens["color-primary"]).toBe("#ff2244");
    expect(g.screenshotObjectKey).toBe("crawl/shot-abc.png");
  });

  it("tool surfaces Markdown + tokens + a pageRef + a screenshot hint — but NEVER raw page-builder HTML", async () => {
    const res = await getImportPageTool.handler(SYSTEM, { importPageId: PAGE_ID }, {
      adapter,
      registry,
      chatSessionId: "gist-test-session",
    } as ToolContext);
    expect(res.ok).toBe(true);
    const c = res.content;
    // The gist: readable content as Markdown.
    expect(c).toContain("Our Pricing");
    expect(c).toContain("Simple plans for growing teams.");
    // Crawled design tokens are cited.
    expect(c).toContain("color-primary");
    // A screenshot handle (the key exists → the LOOK hint, not the UNVERIFIED one).
    expect(c).toContain("get_import_page_screenshot");
    // A pageRef for query_page_html / read_page_more.
    const pageRef = c.match(/pg_[a-z0-9]+/)?.[0];
    expect(pageRef).toBeDefined();
    // THE CONTRACT: no raw page-builder markup reaches the model.
    expect(c).not.toContain("elementor-");
    expect(c).not.toContain("data-elementor");
    expect(c).not.toContain("<div");

    // The pageRef seeded the shared inspection cache, so query_page_html /
    // read_page_more work on this stored page exactly like a live inspect.
    const cached = getPageInspection(pageRef!);
    expect(cached).not.toBeNull();
    expect(cached?.markdown).toContain("Our Pricing");
  });

  it("tool emits the resolved staging import_pages id (issue #422 — every follow-up call needs it)", async () => {
    const res = await getImportPageTool.handler(SYSTEM, { importPageId: PAGE_ID }, {
      adapter,
      registry,
      chatSessionId: "gist-test-session",
    } as ToolContext);
    expect(res.ok).toBe(true);
    // The id line names the id verbatim plus where to pass it — before #422
    // the tool concealed the one field build_page/inventory/notes require.
    expect(res.content).toContain(`Import page id: ${PAGE_ID}`);
    expect(res.content).toContain("page.importPageId");
  });
});
