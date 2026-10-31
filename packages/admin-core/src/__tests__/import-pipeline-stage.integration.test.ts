// SPDX-License-Identifier: MPL-2.0

/**
 * Stage harness for the migration pipeline (speed-up plan, 2026-07-12).
 *
 * Every blocker the live searchviu mission hit past the crawl was a
 * DETERMINISTIC op bug — none needed an AI or a live site to reproduce.
 * This harness replays a recorded slice of the real searchviu crawl
 * (fixtures/searchviu-import-pages.json.gz — home + blog pages, WP
 * preset junk vars included) through the real ops in seconds:
 *
 *   propose_run → write_extracted_pages → update_run_status
 *     → get_import_page / build_page({ importPageId }) → list_pages / get_run_report
 *
 * The CI database is per-job disposable and test files run isolated
 * (`bun test --isolate`); entities created here carry a `svfx-` slug
 * prefix and are deleted in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
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
      const built = (await tx`
        SELECT pm.module_id::text AS id FROM page_modules pm
        JOIN pages p ON p.id = pm.page_id WHERE p.slug LIKE ${`${PREFIX}%`}
      `) as unknown as { id: string }[];
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PREFIX}%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PREFIX}%`}`;
      for (const m of built) await tx`DELETE FROM modules WHERE id = ${m.id}::uuid`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PREFIX}%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PREFIX}%`}`;
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
    password: "meadow-canyon-58",
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

// issue #424 — content-only read against the RECORDED crawl: the real
// searchviu pages carry the exact ballast the 2026-08-04 dogfood measured
// (110KB Elementor header per page, the Complianz modal INSIDE the stored
// content module — this crawl predates the extraction-time consent strip —
// and 47 `--wp--preset--*` tokens, none referenced by any page).
describe("get_import_page content-only on the recorded crawl (issue #424)", () => {
  let blogPageId: string;

  beforeAll(async () => {
    const detected = await execute(registry, adapter, ctx, "imports.detect_boilerplate", {
      runId,
      minPages: 2,
    });
    if (!detected.ok) throw new Error(`detect_boilerplate failed: ${detected.error.kind}`);

    const got = await execute(registry, adapter, ctx, "imports.get", { runId });
    if (!got.ok) throw new Error(`imports.get failed: ${got.error.kind}`);
    const pages = (got.value as { pages: Array<{ id: string; proposedSlug: string }> }).pages;
    const blog = pages.find((p) => p.proposedSlug.includes("bigquery"));
    if (!blog) throw new Error("bigquery fixture page missing");
    blogPageId = blog.id;
  });

  it("default read drops chrome modules, the consent modal, and the whole unreferenced preset dump — loudly", async () => {
    const res = await getImportPageTool.handler(ctx, { importPageId: blogPageId }, {
      adapter,
      registry,
      chatSessionId: "stage-content-only",
    } as ToolContext);
    expect(res.ok).toBe(true);
    const c = res.content;

    expect(c).toContain("## Stripped from this read");
    expect(c).toContain(
      "- source chrome modules (layout-owned — bind ONCE at the layout, never per page): header, footer",
    );
    expect(c).toMatch(/- consent noise: \d+ cookie\/GDPR subtree\(s\)/);
    expect(c).toMatch(/- design tokens: \d+ unreferenced --wp--preset--\* entries dropped/);

    // Header nav + footer text are gone; the article is not.
    expect(c).not.toContain("Smart Alerting");
    expect(c).not.toContain("we once needed ourselves");
    expect(c).toContain("BigQuery");
    // The raw preset dump never reaches the model in this view.
    expect(c).not.toContain("--wp--preset--aspect-ratio--square");

    // Cache: content-only Markdown, FULL html (raw stays reachable).
    const pageRef = c.match(/pg_[a-z0-9]+/)?.[0];
    expect(pageRef).toBeDefined();
    const cached = getPageInspection(pageRef!);
    expect(cached?.markdown).not.toContain("Manage Consent");
    expect(cached?.html).toContain("cmplz");
  });

  it("fullPage: true returns the untouched capture, counters absent", async () => {
    const res = await getImportPageTool.handler(ctx, { importPageId: blogPageId, fullPage: true }, {
      adapter,
      registry,
      chatSessionId: "stage-full-page",
    } as ToolContext);
    expect(res.ok).toBe(true);
    const c = res.content;
    expect(c).not.toContain("## Stripped from this read");
    expect(c).toContain("Smart Alerting"); // header nav is back
    expect(c).toContain("--wp--preset--aspect-ratio--square"); // raw token dump is back
  });
});

// issue #422 — the id-bearing list surface, after every fixture page was
// accepted and linked; the pending-state + build_page-link paths live in
// import-id-chain.integration.test.ts.
describe("imports.list_pages (recorded searchviu crawl, all pages accepted)", () => {
  beforeAll(async () => {
    const tpl = await execute(registry, adapter, ctx, "templates.create", {
      pageType: "home",
      slug: `${PREFIX}tpl`,
      displayName: "Pipeline harness template",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    });
    if (!tpl.ok) throw new Error(`templates.create failed: ${JSON.stringify(tpl.error)}`);
    const templateId = (tpl.value as { templateId: string }).templateId;
    const blocks = await execute(registry, adapter, ctx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    if (!blocks.ok) throw new Error(`template_blocks.set failed: ${JSON.stringify(blocks.error)}`);

    // Link every staged page the way the migration does since #278: the AI
    // rebuilds each one with build_page({ importPageId }), which stamps
    // accepted_page_id. The rebuilt body is a stand-in; these cases read the
    // linkage, not the content. (The recorded crawl's own markup links to
    // pages this harness never builds, which the publish link check rejects.)
    const listed = await execute(registry, adapter, ctx, "imports.list_pages", { runId });
    if (!listed.ok) throw new Error(`imports.list_pages failed: ${listed.error.kind}`);
    const staged = (
      listed.value as { pages: { id: string; proposedSlug: string; proposedTitle: string }[] }
    ).pages;
    // The crawl stages two pages as `home`; the built pages get distinct
    // slugs (never the magic home slug) so each import page links to its
    // own page.
    for (const [i, p] of staged.entries()) {
      const slug = `${PREFIX}built-${i}`;
      const built = await execute(registry, adapter, ctx, "pages.build_page", {
        page: { slug, title: p.proposedTitle, templateId, importPageId: p.id },
        modules: [
          {
            blockName: "content",
            displayName: `Rebuilt ${slug}`,
            description: "Stand-in rebuild of a recorded crawl page",
            kind: "content",
            html: "<section><h2>{{heading}}</h2></section>",
            fields: [{ name: "heading", kind: "text", label: "Heading" }],
            content: { source: "inline", values: { heading: p.proposedTitle } },
          },
        ],
      });
      if (!built.ok) throw new Error(`build_page ${slug}: ${JSON.stringify(built.error)}`);
    }
  });

  it("lists every page with its staging id, rebuild status, and built-page link", async () => {
    const r = await execute(registry, adapter, ctx, "imports.list_pages", { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      run: { id: string; status: string; sourceUrl: string };
      total: number;
      pages: { id: string; proposedSlug: string; status: string; acceptedPageId: string | null }[];
    };
    expect(v.run.id).toBe(runId);
    expect(v.total).toBe(FIXTURE.length);
    expect(v.pages.length).toBe(FIXTURE.length);
    for (const p of v.pages) {
      expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(p.status).toBe("accepted");
      expect(p.acceptedPageId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("filters by status and searches by slug/url/title", async () => {
    const pending = await execute(registry, adapter, ctx, "imports.list_pages", {
      runId,
      status: "pending",
    });
    expect(pending.ok).toBe(true);
    if (pending.ok) expect((pending.value as { total: number }).total).toBe(0);

    const first = FIXTURE[0];
    if (!first) throw new Error("fixture empty");
    const bySlug = await execute(registry, adapter, ctx, "imports.list_pages", {
      runId,
      search: `${PREFIX}${first.proposed_slug}`.slice(0, 60),
    });
    expect(bySlug.ok).toBe(true);
    if (bySlug.ok) {
      const v = bySlug.value as { pages: { proposedSlug: string }[] };
      expect(v.pages.length).toBeGreaterThanOrEqual(1);
    }

    const miss = await execute(registry, adapter, ctx, "imports.list_pages", {
      runId,
      search: "no-such-page-zzz",
    });
    expect(miss.ok).toBe(true);
    if (miss.ok) expect((miss.value as { total: number }).total).toBe(0);

    // `limit` caps the rows while `total` still names the full match count,
    // so truncation is visible (Copilot review on PR #437: the tool exposes
    // the op's limit for crawls beyond the 200-row default).
    const capped = await execute(registry, adapter, ctx, "imports.list_pages", {
      runId,
      limit: 1,
    });
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      const v = capped.value as { total: number; pages: unknown[] };
      expect(v.pages.length).toBe(1);
      expect(v.total).toBe(FIXTURE.length);
    }
  });

  it("run report's rebuilt counter reflects the linked pages", async () => {
    // The same accepted_page_id linkage list_pages surfaces is what the
    // report counts — every fixture page is accepted/linked.
    const r = await execute(registry, adapter, ctx, "imports.get_run_report", { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { acceptedPages: number }).acceptedPages).toBe(FIXTURE.length);
  });
});
