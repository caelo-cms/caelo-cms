// SPDX-License-Identifier: MPL-2.0

/**
 * issue #422 (+ #263, #360) — the import-page ID CHAIN, end to end.
 *
 * The 2026-08-04 dogfood import broke at every link that needs an
 * `import_pages.id`: no list surface carried the ids, `add_import_page_notes`
 * rejected the CMS page id the AI held (#263), `check_page_content_inventory`
 * reported "54/54 missing" on a demonstrably complete page, and the run
 * report counted 0 rebuilt pages. Two distinct root causes:
 *
 *   1. ID STARVATION — nothing listed the staging ids, so build_page was
 *      called without `importPageId`, no `accepted_page_id` link was ever
 *      stamped, and every downstream resolver fell back to slug matching
 *      (`imports.list_pages` + the resolver-backed notes op fix this).
 *   2. BRANCH BLINDNESS — build_page inside a chat records placements ONLY
 *      as branch snapshots (`if (!branched)` in ops/content/build-page.ts),
 *      but the inventory diff read live `page_modules` — empty for exactly
 *      the flow that calls it. Every source item counted as missing: the
 *      "N/N missing" false negative. The fix reads the rebuilt page through
 *      the same branch-overlay loaders every other chat read uses.
 *
 * #360's reported shape (built page id whose slug equals proposed_slug,
 * rejected as "not found") is covered here as its own regression case.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { listImportPagesTool } from "../ai/tools/list-import-pages.js";
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
  requestId: "idchain-sys",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "idchain-ai",
};

const TPL = "idchain-tpl";
const SLUG_A = "idchain-a";
const SLUG_B = "idchain-b";
const RUN_MARK = "http://127.0.0.1/idchain?run";
const SESSION_TITLE = "idchain-branch-session";

// Source content whose every inventory item (heading / paragraph / list
// items / link) is comfortably above the coverage matcher's minimum
// substring length, so covered-vs-missing is deterministic.
const SRC_A_HTML =
  "<h2>Alpha Services Overview</h2>" +
  "<p>We deliver alpha quality to every customer.</p>" +
  '<a href="/idchain-contact">Contact the alpha service team</a>';
const SRC_B_HTML =
  "<h2>Beta Features Overview</h2>" +
  "<p>Beta is thoroughly tested in production.</p>" +
  "<ul><li>Fast beta rollouts everywhere</li><li>Safe beta rollbacks guaranteed</li></ul>";

let runId = "";
let stagingA = "";
let stagingB = "";
let builtA = "";
let builtB = "";
let chatBranchId = "";

async function wipe(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM chat_sessions WHERE title = ${SESSION_TITLE}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
    await tx`DELETE FROM pages WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${"idchain-%"})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${"idchain-%"}`;
    await tx`DELETE FROM templates WHERE slug = ${TPL}`;
    await tx`DELETE FROM import_pages WHERE run_id IN (SELECT id FROM import_runs WHERE source_url = ${RUN_MARK})`;
    await tx`DELETE FROM import_runs WHERE source_url = ${RUN_MARK}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL);
  await wipe();

  // Seed the run directly at 'ready_for_review' (never 'crawling', so a
  // co-running crawl worker can never claim the unreachable-URL run).
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const rows = (await tx`
      INSERT INTO import_runs (source_url, status, proposed_by, pages_seen, pages_extracted)
      VALUES (${RUN_MARK}, 'ready_for_review', ${SYSTEM.actorId}::uuid, 2, 2)
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    runId = rows[0]?.id ?? "";
  });
  if (runId === "") throw new Error("run seed failed");

  const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      {
        sourceUrl: "http://127.0.0.1/alpha",
        proposedSlug: SLUG_A,
        proposedTitle: "Alpha",
        proposedModules: [
          { blockName: "content", position: 0, html: SRC_A_HTML, displayName: "Alpha Content" },
        ],
        proposedThemeTokens: {},
        signature: "idchain-a",
      },
      {
        sourceUrl: "http://127.0.0.1/beta",
        proposedSlug: SLUG_B,
        proposedTitle: "Beta",
        proposedModules: [
          { blockName: "content", position: 0, html: SRC_B_HTML, displayName: "Beta Content" },
        ],
        proposedThemeTokens: {},
        signature: "idchain-b",
      },
    ],
  });
  if (!wrote.ok) throw new Error(`write_extracted_pages: ${JSON.stringify(wrote.error)}`);

  // Template with a 'content' block for the direct builds.
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL,
    displayName: "Idchain",
    html: "<main>{{content}}</main>",
    css: "",
  });
  if (!tpl.ok) throw new Error(`templates.create: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  const blocks = await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!blocks.ok) throw new Error(`template_blocks.set: ${JSON.stringify(blocks.error)}`);
});

afterAll(async () => {
  await wipe();
  await sqlc.end();
  await adapter.close();
});

async function templateIdBySlug(): Promise<string> {
  let id = "";
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const rows = (await tx`
      SELECT id::text AS id FROM templates WHERE slug = ${TPL} LIMIT 1
    `) as unknown as { id: string }[];
    id = rows[0]?.id ?? "";
  });
  return id;
}

describe("import-page id chain (issues #422 / #263 / #360)", () => {
  it("list_pages surfaces the staging ids for a fresh run (all pending)", async () => {
    const r = await execute(registry, adapter, AI, "imports.list_pages", { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      run: { status: string };
      total: number;
      pages: { id: string; proposedSlug: string; status: string; acceptedPageId: string | null }[];
    };
    expect(v.run.status).toBe("ready_for_review");
    expect(v.total).toBe(2);
    const a = v.pages.find((p) => p.proposedSlug === SLUG_A);
    const b = v.pages.find((p) => p.proposedSlug === SLUG_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;
    expect(a.status).toBe("pending");
    expect(a.acceptedPageId).toBeNull();
    stagingA = a.id;
    stagingB = b.id;
  });

  it("list_import_pages tool prints the ids + the follow-up contract", async () => {
    const res = await listImportPagesTool.handler(AI, { runId }, {
      adapter,
      registry,
      chatSessionId: "idchain-tool-session",
    } as ToolContext);
    expect(res.ok).toBe(true);
    expect(res.content).toContain(stagingA);
    expect(res.content).toContain(stagingB);
    expect(res.content).toContain("importPageId");
  });

  it("#360 shape: inventory accepts the BUILT page id when slug equals proposed_slug", async () => {
    // The dogfood shape: build_page WITHOUT importPageId (the AI had no way
    // to obtain the id) — no accepted link is stamped, resolution must go
    // through the slug match.
    const templateId = await templateIdBySlug();
    const built = await execute(registry, adapter, SYSTEM, "pages.build_page", {
      page: { slug: SLUG_A, title: "Alpha", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "Idchain Alpha Body",
          description: "Rebuilt alpha content",
          kind: "content",
          html: '<section><h2>{{a_heading}}</h2><p>{{a_body}}</p><a href="{{a_link_href}}">{{a_link_label}}</a></section>',
          fields: [
            { name: "a_heading", kind: "text", label: "Heading" },
            { name: "a_body", kind: "text", label: "Body" },
            { name: "a_link_href", kind: "url", label: "Link href" },
            { name: "a_link_label", kind: "text", label: "Link label" },
          ],
          content: {
            source: "inline",
            values: {
              a_heading: "Alpha Services Overview",
              a_body: "We deliver alpha quality to every customer.",
              a_link_href: "/idchain-contact",
              a_link_label: "Contact the alpha service team",
            },
          },
        },
      ],
    });
    if (!built.ok) throw new Error(`build_page A: ${JSON.stringify(built.error)}`);
    builtA = (built.value as { pageId: string }).pageId;

    // #360's exact claim: this resolves via slug === proposed_slug. It does.
    const inv = await execute(registry, adapter, AI, "imports.check_page_inventory", {
      importPageId: builtA,
    });
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    const v = inv.value as { total: number; covered: number; missing: number };
    expect(v.total).toBeGreaterThan(0);
    expect(v.missing).toBe(0);
    expect(v.covered).toBe(v.total);
  });

  it("#263: add_page_notes accepts the built CMS page id even with NO accepted link", async () => {
    // Pre-fix the op's inline lookup knew only staging id / accepted link;
    // with no link stamped, the CMS page id the AI naturally holds bounced
    // with an error steering to the nonexistent `imports.get`.
    const byBuilt = await execute(registry, adapter, AI, "imports.add_page_notes", {
      importPageId: builtA,
      notes: [{ category: "typo", note: "Fixed 'qualitty' in the intro.", applied: true }],
    });
    expect(byBuilt.ok).toBe(true);
    if (byBuilt.ok) expect((byBuilt.value as { totalNotes: number }).totalNotes).toBe(1);

    const byStaging = await execute(registry, adapter, AI, "imports.add_page_notes", {
      importPageId: stagingA,
      notes: [
        {
          category: "improvement",
          note: "Alpha page could link the pricing page.",
          applied: false,
        },
      ],
    });
    expect(byStaging.ok).toBe(true);
    if (byStaging.ok) expect((byStaging.value as { totalNotes: number }).totalNotes).toBe(2);
  });

  it("error prose points at list_import_pages, never at the toolless imports.get", async () => {
    // A well-FORMED v4 uuid that matches no row — a malformed one would
    // bounce at the Zod boundary and never reach the resolver's message.
    const miss = await execute(registry, adapter, AI, "imports.add_page_notes", {
      importPageId: "a4220000-dead-4bad-8bad-a42200000360",
      notes: [{ category: "typo", note: "n/a", applied: false }],
    });
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    const msg = (miss.error as { message?: string }).message ?? "";
    expect(msg).toContain("list_import_pages");
    expect(msg).not.toContain("imports.get");
  });

  it("branch blindness regression: a chat-branch rebuild passes the inventory check", async () => {
    const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: SESSION_TITLE,
    });
    if (!session.ok) throw new Error(`create_session: ${JSON.stringify(session.error)}`);
    chatBranchId = (session.value as { chatBranchId: string }).chatBranchId;
    const branchedAi: ExecutionContext = { ...AI, chatBranchId };

    const templateId = await templateIdBySlug();
    const built = await execute(registry, adapter, branchedAi, "pages.build_page", {
      page: { slug: SLUG_B, title: "Beta", templateId, importPageId: stagingB },
      modules: [
        {
          blockName: "content",
          displayName: "Idchain Beta Body",
          description: "Rebuilt beta content",
          kind: "content",
          html: "<section><h2>{{b_heading}}</h2><p>{{b_body}}</p><ul><li>{{b_item_one}}</li><li>{{b_item_two}}</li></ul></section>",
          fields: [
            { name: "b_heading", kind: "text", label: "Heading" },
            { name: "b_body", kind: "text", label: "Body" },
            { name: "b_item_one", kind: "text", label: "Item one" },
            { name: "b_item_two", kind: "text", label: "Item two" },
          ],
          content: {
            source: "inline",
            values: {
              b_heading: "Beta Features Overview",
              b_body: "Beta is thoroughly tested in production.",
              b_item_one: "Fast beta rollouts everywhere",
              b_item_two: "Safe beta rollbacks guaranteed",
            },
          },
        },
      ],
    });
    if (!built.ok) throw new Error(`build_page B: ${JSON.stringify(built.error)}`);
    builtB = (built.value as { pageId: string }).pageId;

    // THE REPRO SHAPE: the branched build linked the import row but wrote
    // ZERO live page_modules rows — the rebuild exists only as branch
    // snapshots until publish.
    let liveRows = -1;
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT count(*)::int AS n FROM page_modules WHERE page_id = ${builtB}::uuid
      `) as unknown as { n: number }[];
      liveRows = rows[0]?.n ?? -1;
    });
    expect(liveRows).toBe(0);

    // Pre-fix: the live-only read found no rebuilt content and reported
    // EVERY source item missing ("54/54 missing"). The overlay-aware read
    // sees the branched placements + content values.
    const byStaging = await execute(registry, adapter, branchedAi, "imports.check_page_inventory", {
      importPageId: stagingB,
    });
    expect(byStaging.ok).toBe(true);
    if (byStaging.ok) {
      const v = byStaging.value as { total: number; covered: number; missing: number };
      expect(v.total).toBeGreaterThan(0);
      expect(v.missing).toBe(0);
      expect(v.covered).toBe(v.total);
    }

    // Dual-id through the same branch: the built page id resolves too.
    const byBuilt = await execute(registry, adapter, branchedAi, "imports.check_page_inventory", {
      importPageId: builtB,
    });
    expect(byBuilt.ok).toBe(true);
    if (byBuilt.ok) expect((byBuilt.value as { missing: number }).missing).toBe(0);
  });

  it("rebuilt counter: unlinked builds count 0; the importPageId link heals it", async () => {
    // Page A was built WITHOUT importPageId (dogfood shape) — only the
    // branch-linked page B counts so far.
    const before = await execute(registry, adapter, AI, "imports.get_run_report", { runId });
    expect(before.ok).toBe(true);
    if (before.ok) expect((before.value as { acceptedPages: number }).acceptedPages).toBe(1);

    // The heal move the id chain enables: rebuild targeting the existing
    // page WITH the staging id (from list_import_pages) — stamps the link.
    const heal = await execute(registry, adapter, SYSTEM, "pages.build_page", {
      page: { pageId: builtA, importPageId: stagingA },
      modules: [],
    });
    expect(heal.ok).toBe(true);

    const after = await execute(registry, adapter, AI, "imports.get_run_report", { runId });
    expect(after.ok).toBe(true);
    if (after.ok) expect((after.value as { acceptedPages: number }).acceptedPages).toBe(2);

    // list_pages reflects the healed chain: both accepted, both linked.
    const list = await execute(registry, adapter, AI, "imports.list_pages", {
      runId,
      status: "accepted",
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const v = list.value as {
      total: number;
      pages: { proposedSlug: string; acceptedPageId: string | null }[];
    };
    expect(v.total).toBe(2);
    expect(v.pages.find((p) => p.proposedSlug === SLUG_A)?.acceptedPageId).toBe(builtA);
    expect(v.pages.find((p) => p.proposedSlug === SLUG_B)?.acceptedPageId).toBe(builtB);
  });
});
