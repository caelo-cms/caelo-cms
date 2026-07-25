// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: the per-page import reads must resolve a directly-built (#278)
 * HOMEPAGE. The crawler always assigns the root `proposed_slug = 'home'`, but
 * issue 0184 lets ANY page be the site root via `locales.home_page_id`, so a
 * migrate flow that builds the homepage at a custom/translated slug (e.g.
 * `startseite`) breaks the old `proposed_slug == page.slug` match — the AI
 * saw "import page not found — again and again" (reported in chat).
 *
 * `resolveImportPageRef` now also matches the built home page via its
 * home-page designation, in BOTH directions (built page id ↔ staging id), so
 * `imports.check_page_inventory` and `imports.get_page_screenshot_keys`
 * resolve it. Import rows never expire, so this was a linkage bug, not a TTL.
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
  requestId: "invhome-sys",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "invhome-ai",
};

const TPL = "invhome-tpl";
const CUSTOM_SLUG = "invhome-startseite";
const RUN_MARK = "http://127.0.0.1/invhome?run";

let originalHomePageId: string | null = null;
let runId = "";
let importPageId = "";
let composedPageId = "";

async function wipe(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    // Restore the seed home designation we borrowed.
    await tx`UPDATE locales SET home_page_id = ${originalHomePageId} WHERE code = 'en'`;
    if (composedPageId) {
      await tx`DELETE FROM page_modules WHERE page_id = ${composedPageId}::uuid`;
      await tx`DELETE FROM pages WHERE id = ${composedPageId}::uuid`;
    }
    if (runId) {
      await tx`DELETE FROM import_pages WHERE run_id = ${runId}::uuid`;
      await tx`DELETE FROM import_runs WHERE id = ${runId}::uuid`;
    }
    await tx`DELETE FROM templates WHERE slug = ${TPL}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL);
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const rows = (await tx`
      SELECT home_page_id::text AS id FROM locales WHERE code = 'en'
    `) as unknown as { id: string | null }[];
    originalHomePageId = rows[0]?.id ?? null;
  });
});

afterAll(async () => {
  await wipe();
  await sqlc.end();
  await adapter.close();
});

describe("import page reads — directly-built homepage-not-at-root (#278)", () => {
  it("resolves the built home page (custom slug) via its home-page designation, both id directions", async () => {
    // 1. Seed the run directly at 'ready_for_review'. We do NOT go through
    // create_run ('crawling') because a crawl worker bootstrapped by a
    // co-running dev server would claim the unreachable-127.0.0.1 run and mark
    // it 'failed', racing the test. A run that is never 'crawling' is never
    // claimed. The crawler would assign the root page proposed_slug 'home'.
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        INSERT INTO import_runs (source_url, status, proposed_by, pages_seen, pages_extracted)
        VALUES (${RUN_MARK}, 'ready_for_review', ${SYSTEM.actorId}::uuid, 1, 1)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      runId = rows[0]?.id ?? "";
    });
    expect(runId).not.toBe("");

    const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
      runId,
      pages: [
        {
          sourceUrl: "http://127.0.0.1/",
          proposedSlug: "home",
          proposedTitle: "Home",
          proposedModules: [
            {
              blockName: "content",
              position: 0,
              html: "<h2>Willkommen</h2><p>Frisch gebacken jeden Morgen.</p>",
              displayName: "Home Content",
            },
          ],
          proposedThemeTokens: {},
          signature: "home",
        },
      ],
    });
    if (!wrote.ok) throw new Error(`write_extracted_pages: ${JSON.stringify(wrote.error)}`);
    // compose builds the page + modules and links accepted_page_id.
    const composed = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
      runId,
      templateSlug: TPL,
    });
    if (!composed.ok) throw new Error(JSON.stringify(composed.error));

    let idRows: { id: string; pid: string | null }[] = [];
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      idRows = (await tx`
        SELECT id::text AS id, accepted_page_id::text AS pid
        FROM import_pages WHERE run_id = ${runId}::uuid LIMIT 1
      `) as unknown as { id: string; pid: string | null }[];
    });
    importPageId = idRows[0]?.id ?? "";
    composedPageId = idRows[0]?.pid ?? "";
    expect(importPageId).not.toBe("");
    expect(composedPageId).not.toBe("");

    // 2. Turn it into the #278 homepage-not-at-root shape:
    //    - drop the compose link (a directly-built page has none),
    //    - give the built page a CUSTOM slug (not the crawler's 'home'),
    //    - designate it as the site root via the home-page pointer.
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE import_pages SET accepted_page_id = NULL WHERE run_id = ${runId}::uuid`;
      await tx`UPDATE pages SET slug = ${CUSTOM_SLUG} WHERE id = ${composedPageId}::uuid`;
    });
    const setHome = await execute(registry, adapter, AI, "pages.set_home_page", {
      pageId: composedPageId,
      locale: "en",
    });
    expect(setHome.ok).toBe(true);

    // 3. THE REGRESSION: check_page_inventory with the BUILT page id.
    //    Old code matched proposed_slug=='home' against slug=='invhome-startseite'
    //    → "import page not found". Now it resolves via home_page_id.
    const inv = await execute(registry, adapter, AI, "imports.check_page_inventory", {
      importPageId: composedPageId,
    });
    expect(inv.ok).toBe(true);

    // The screenshot-keys sibling resolves the same way.
    const keys = await execute(registry, adapter, AI, "imports.get_page_screenshot_keys", {
      importPageId: composedPageId,
    });
    expect(keys.ok).toBe(true);

    // 4. The reliable escape hatch: the staging import_pages.id ALSO resolves
    //    (and the inventory recovers the built home page for the diff target).
    const invByStaging = await execute(registry, adapter, AI, "imports.check_page_inventory", {
      importPageId,
    });
    expect(invByStaging.ok).toBe(true);

    // A bogus id still fails loudly (no false positive).
    const bogus = await execute(registry, adapter, AI, "imports.check_page_inventory", {
      importPageId: "00000000-0000-0000-0000-0000000000aa",
    });
    expect(bogus.ok).toBe(false);
  });
});
