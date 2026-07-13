// SPDX-License-Identifier: MPL-2.0

/**
 * Run #9 R8 regression — a FAILED `imports.compose_from_run` leaves
 * NOTHING behind.
 *
 * The op runs inside one transaction, but pre-fix its mid-loop failure
 * paths `return err(...)` — and drizzle only rolls back on a THROW, so
 * the error COMMITTED every row written before the failing page (run
 * #9: 23 mangled pages persisted although compose errored with
 * "redirect /tools → /ols would shadow the existing page"). The
 * handler now throws `OperationAbortError` for post-write failures;
 * the adapter rolls back and returns the same structured error.
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
  requestId: "run9-r8-compose",
};

/** The live page that makes the second import page's redirect a shadow. */
const SHADOW_SLUG = "run9x-tools";
const TPL_SLUG = "run9x-shadow-tpl";

let runId: string;
let shadowPageId: string;
let homeImportPageId: string;

async function cleanupFixtures(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'run9x-%')`;
    await tx`DELETE FROM redirects WHERE from_path LIKE '/run9x-%'`;
    await tx`DELETE FROM pages WHERE slug LIKE 'run9x-%'`;
    await tx`DELETE FROM content_instances WHERE module_id IN (
      SELECT id FROM modules WHERE slug LIKE 'imported-%'
    ) AND id NOT IN (SELECT content_instance_id FROM page_modules)`;
    await tx`DELETE FROM layout_modules WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE 'imported-%')`;
    await tx`DELETE FROM modules WHERE slug LIKE 'imported-%'
      AND id NOT IN (SELECT module_id FROM page_modules)`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE 'run9x-imported%' OR slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug LIKE 'run9x-imported%' OR slug = ${TPL_SLUG}`;
    await tx`DELETE FROM import_pages WHERE source_url LIKE 'https://run9x.example%'`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE 'https://run9x.example%'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL as string);
  await cleanupFixtures();

  // A pre-existing LIVE page owning /run9x-tools — the second import
  // page's source path — so compose's shadow check trips mid-loop.
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL_SLUG,
    displayName: "Run9 shadow tpl",
    html: "<main>{{content}}</main>",
    css: "",
  });
  if (!tpl.ok) throw new Error(JSON.stringify(tpl.error));
  const shadowPage = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: SHADOW_SLUG,
    locale: "en",
    title: "Existing tools page",
    templateId: (tpl.value as { templateId: string }).templateId,
    status: "draft",
  });
  if (!shadowPage.ok) throw new Error(JSON.stringify(shadowPage.error));
  shadowPageId = (shadowPage.value as { pageId: string }).pageId;

  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: "https://run9x.example/",
    depth: 2,
    maxPages: 10,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  runId = (run.value as { runId: string }).runId;

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
        sourceUrl: "https://run9x.example/",
        proposedSlug: "run9x-home",
        proposedTitle: "Home",
        proposedModules: [content("Welcome")],
        proposedThemeTokens: {},
        signature: "home",
        pageCss: "",
      },
      {
        // Source path /run9x-tools; proposed slug differs, so compose
        // must write a redirect — which would shadow the live page
        // created above → the mid-loop failure.
        sourceUrl: "https://run9x.example/run9x-tools",
        proposedSlug: "run9x-tools-rebuilt",
        proposedTitle: "Tools",
        proposedModules: [content("Tools")],
        proposedThemeTokens: {},
        signature: "/tools|x1",
        pageCss: "",
      },
    ],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));

  const ready = await execute(registry, adapter, SYSTEM, "imports.update_run_status", {
    runId,
    status: "ready_for_review",
    pagesSeen: 2,
    pagesExtracted: 2,
  });
  if (!ready.ok) throw new Error(JSON.stringify(ready.error));

  const importPages = (await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    return await tx`SELECT id::text AS id, source_url FROM import_pages WHERE run_id = ${runId}::uuid`;
  })) as unknown as { id: string; source_url: string }[];
  const home = importPages.find((p) => p.source_url === "https://run9x.example/");
  if (!home) throw new Error("home import page missing");
  homeImportPageId = home.id;
});

afterAll(async () => {
  await cleanupFixtures();
  await sqlc.end();
  await adapter.close();
});

describe("run #9 R8 — compose_from_run is all-or-nothing", () => {
  it("a mid-loop shadow-redirect failure rolls back EVERY write of the compose", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
      runId,
      templateSlug: "run9x-imported",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected compose to fail");
    expect(JSON.stringify(r.error)).toContain("would shadow");

    const residue = (await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const pages = await tx`
        SELECT id FROM pages WHERE slug IN ('run9x-home', 'run9x-tools-rebuilt')`;
      const templates = await tx`
        SELECT id FROM templates WHERE slug LIKE 'run9x-imported%'`;
      const accepted = await tx`
        SELECT id FROM import_pages WHERE run_id = ${runId}::uuid AND accepted_page_id IS NOT NULL`;
      const redirects = await tx`
        SELECT id FROM redirects WHERE from_path LIKE '/run9x-%'`;
      return {
        pages: (pages as unknown as unknown[]).length,
        templates: (templates as unknown as unknown[]).length,
        accepted: (accepted as unknown as unknown[]).length,
        redirects: (redirects as unknown as unknown[]).length,
      };
    })) as { pages: number; templates: number; accepted: number; redirects: number };

    // Pre-fix: pages=1 (the home page committed), templates>=1,
    // accepted=1. Post-fix: zero residue across the board.
    expect(residue).toEqual({ pages: 0, templates: 0, accepted: 0, redirects: 0 });

    // The pre-existing live page is untouched.
    const shadowRows = (await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`SELECT id::text AS id FROM pages WHERE id = ${shadowPageId}::uuid AND deleted_at IS NULL`;
    })) as unknown as { id: string }[];
    expect(shadowRows).toHaveLength(1);
  });

  it("the rolled-back run stays composable: excluding the conflicting page succeeds", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
      runId,
      templateSlug: "run9x-imported",
      includeImportPageIds: [homeImportPageId],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const v = r.value as { pageIds: string[]; homepageId: string | null };
    expect(v.pageIds).toHaveLength(1);
    expect(v.homepageId).not.toBeNull();
  });
});
