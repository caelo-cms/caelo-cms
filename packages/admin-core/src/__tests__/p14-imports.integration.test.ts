// SPDX-License-Identifier: MPL-2.0

/**
 * P14 imports happy-path integration test. Exercises the full loop:
 *   AI propose_run → Owner execute_proposal → write_extracted_pages
 *   (simulating the orchestrator tick) → accept_page → assert pages +
 *   page_modules + modules rows exist.
 *
 * Also asserts the §11.A gate: AI calls execute_proposal directly →
 * ActorScopeRejected.
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

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p14-imports-test",
};
// Mint an AI actor via raw SQL so we can verify the §11.A gate. The
// admin's AI-actor row is set by the chat-runner in production; in
// tests we just need a stable id with kind='ai'.
const AI_ACTOR_ID = "00000000-0000-0000-0000-0000000abcde";
const aiCtx: ExecutionContext = {
  actorId: AI_ACTOR_ID,
  actorKind: "ai",
  requestId: "p14-imports-test-ai",
};

const TPL_SLUG = "p14-imp-tpl";
const SOURCE_URL = "https://example.test/p14-imports";

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_pages WHERE source_url LIKE 'https://example.test/p14%'`;
      await tx`DELETE FROM import_runs WHERE source_url = ${SOURCE_URL}`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'p14-imports-%')`;
      await tx`DELETE FROM pages WHERE slug LIKE 'p14-imports-%'`;
      await tx`DELETE FROM modules WHERE slug LIKE 'imported-%'`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
      // Keep the AI actor row across runs — its id is stable and audit
      // rows reference it via FK, so deleting it would fail.
    });
  } finally {
    await sql.end();
  }
}

let templateId = "";

beforeAll(async () => {
  await wipe(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  // Seed a template + AI actor.
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO actors (id, kind, display_name)
        VALUES (${AI_ACTOR_ID}::uuid, 'ai', 'P14 test AI')
        ON CONFLICT (id) DO NOTHING
      `;
    });
  } finally {
    await sql.end();
  }

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "P14 imp tpl",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [
      { name: "header", displayName: "Header", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
      { name: "footer", displayName: "Footer", position: 2 },
    ],
  });
});

afterAll(async () => {
  await wipe(ADMIN_URL);
});

describe("P14 imports happy path (propose → execute → write → accept)", () => {
  it("rejects AI calling execute_proposal directly (§11.A gate)", async () => {
    const propose = await execute(registry, adapter, aiCtx, "imports.propose_run", {
      sourceUrl: SOURCE_URL,
      depth: 1,
      maxPages: 3,
    });
    expect(propose.ok).toBe(true);
    const runId = (propose.value as { runId: string }).runId;

    const exec = await execute(registry, adapter, aiCtx, "imports.execute_proposal", { runId });
    expect(exec.ok).toBe(false);
    if (!exec.ok) {
      expect(exec.error.kind).toBe("ActorScopeRejected");
    }
  });

  it("full loop: AI proposes → Owner executes → write_extracted_pages → accept_page → real page exists", async () => {
    // 1. AI proposes the crawl.
    const propose = await execute(registry, adapter, aiCtx, "imports.propose_run", {
      sourceUrl: `${SOURCE_URL}-loop`,
      depth: 1,
      maxPages: 3,
    });
    expect(propose.ok).toBe(true);
    const runId = (propose.value as { runId: string }).runId;

    // 2. Pending queue surfaces it.
    const pending = await execute(registry, adapter, aiCtx, "imports.list_pending_proposals", {});
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      const runs = (pending.value as { runs: Array<{ id: string }> }).runs;
      expect(runs.some((r) => r.id === runId)).toBe(true);
    }

    // 3. Owner approves (system kind covers the human path in tests).
    const approve = await execute(registry, adapter, systemCtx, "imports.execute_proposal", {
      runId,
    });
    expect(approve.ok).toBe(true);

    // 4. Worker would normally crawl; we synthesize the result the
    //    importer extracts for one page (header + content + footer split).
    const writeRes = await execute(registry, adapter, systemCtx, "imports.write_extracted_pages", {
      runId,
      pages: [
        {
          sourceUrl: `${SOURCE_URL}-loop/about`,
          proposedSlug: "p14-imports-about",
          proposedTitle: "About us",
          proposedModules: [
            {
              blockName: "header",
              position: 0,
              html: "<header><h1>About us</h1></header>",
              displayName: "Header",
            },
            {
              blockName: "content",
              position: 1,
              html: "<main><p>We make tools.</p></main>",
              displayName: "Content",
            },
            {
              blockName: "footer",
              position: 2,
              html: "<footer>© 2026</footer>",
              displayName: "Footer",
            },
          ],
          proposedThemeTokens: { "color-primary": "#0066ff" },
        },
      ],
    });
    expect(writeRes.ok).toBe(true);

    // 5. The run is now ready_for_review with one page staged.
    const get = await execute(registry, adapter, systemCtx, "imports.get", { runId });
    expect(get.ok).toBe(true);
    if (!get.ok) throw new Error("imports.get failed");
    const got = get.value as {
      run: { status: string };
      pages: Array<{ id: string; proposedSlug: string }>;
    };
    expect(got.pages).toHaveLength(1);
    expect(got.pages[0]?.proposedSlug).toBe("p14-imports-about");
    const importPageId = got.pages[0]?.id;
    if (!importPageId) throw new Error("import page missing");

    // 6. Owner accepts → real `pages` row + 3 page_modules + 3 modules.
    const accept = await execute(registry, adapter, systemCtx, "imports.accept_page", {
      importPageId,
      templateId,
    });
    if (!accept.ok) throw new Error(`accept failed: ${JSON.stringify(accept.error)}`);
    const newPageId = (accept.value as { pageId: string }).pageId;
    expect(newPageId).toBeTruthy();

    // 7. Probe the row directly to assert the writes landed.
    const sql = new SQL(ADMIN_URL);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const pages = (await tx`
          SELECT slug, status, locale, template_id::text AS template_id
          FROM pages WHERE id = ${newPageId}::uuid
        `) as unknown as Array<{
          slug: string;
          status: string;
          locale: string;
          template_id: string;
        }>;
        expect(pages).toHaveLength(1);
        expect(pages[0]?.slug).toBe("p14-imports-about");
        expect(pages[0]?.status).toBe("draft");
        expect(pages[0]?.locale).toBe("en");
        expect(pages[0]?.template_id).toBe(templateId);

        const pms = (await tx`
          SELECT block_name, position FROM page_modules
          WHERE page_id = ${newPageId}::uuid
          ORDER BY block_name, position
        `) as unknown as Array<{ block_name: string; position: number }>;
        // issue #253 (WS0) — accept_page never mints per-page chrome;
        // header/footer are layout-owned (compose_from_run binds them).
        expect(pms).toHaveLength(1);
        expect(pms.map((p) => p.block_name)).toEqual(["content"]);
      });
    } finally {
      await sql.end();
    }

    // 8. Re-accepting the same import_page is rejected.
    const reAccept = await execute(registry, adapter, systemCtx, "imports.accept_page", {
      importPageId,
      templateId,
    });
    expect(reAccept.ok).toBe(false);
  });
});
