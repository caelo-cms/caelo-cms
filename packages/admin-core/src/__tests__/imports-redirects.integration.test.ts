// SPDX-License-Identifier: MPL-2.0

/**
 * issue #196 — URL continuity for migrations: every composed page
 * whose old path differs from its Caelo path gets a 301 in the SAME
 * transaction; the root never redirects; re-compose never duplicates;
 * shadowing a live page fails loudly with the fix named.
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
  requestId: "issue196-redirects",
};

async function cleanup(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM redirects WHERE from_path LIKE '/issue196%' OR from_path LIKE '/alt-pfad%'`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'issue196-%')`;
    await tx`DELETE FROM pages WHERE slug LIKE 'issue196-%'`;
    await tx`DELETE FROM content_instances WHERE module_id IN (
      SELECT id FROM modules WHERE slug LIKE 'imported-%'
    ) AND id NOT IN (SELECT content_instance_id FROM page_modules)`;
    await tx`DELETE FROM modules WHERE slug LIKE 'imported-%'
      AND id NOT IN (SELECT module_id FROM page_modules)`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE 'issue196-tpl%')`;
    await tx`DELETE FROM templates WHERE slug LIKE 'issue196-tpl%'`;
    await tx`DELETE FROM import_pages WHERE source_url LIKE 'https://issue196.example%'`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE 'https://issue196.example%'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL!);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sqlc.end();
  await adapter.close();
});

async function seedRun(): Promise<string> {
  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: "https://issue196.example/",
    depth: 2,
    maxPages: 50,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  const runId = (run.value as { runId: string }).runId;
  const page = (sourceUrl: string, slug: string, sig: string) => ({
    sourceUrl,
    proposedSlug: slug,
    proposedTitle: slug,
    proposedModules: [
      { blockName: "content", position: 0, html: `<section>${slug}</section>`, displayName: slug },
    ],
    proposedThemeTokens: {},
    signature: sig,
  });
  const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      page("https://issue196.example/", "issue196-home", "home"),
      // Path differs from slug → redirect expected.
      page("https://issue196.example/alt-pfad/artikel.html", "issue196-artikel", "/x/*|a"),
      // Path equals the Caelo path → NO redirect.
      page("https://issue196.example/issue196-kontakt", "issue196-kontakt", "/x/*|a"),
    ],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  await execute(registry, adapter, SYSTEM, "imports.update_run_status", {
    runId,
    status: "ready_for_review",
    pagesSeen: 3,
    pagesExtracted: 3,
  });
  return runId;
}

describe("compose redirects (#196)", () => {
  it("creates 301s for changed paths only; root and same-path pages get none; re-run is idempotent", async () => {
    const runId = await seedRun();
    const r = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
      runId,
      templateSlug: "issue196-tpl",
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect((r.value as { redirectsCreated: number }).redirectsCreated).toBe(1);

    const rows = (await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`
        SELECT from_path, to_path, status_code FROM redirects
        WHERE from_path LIKE '/alt-pfad%' OR from_path = '/' OR from_path LIKE '/issue196%'
        ORDER BY from_path
      `;
    })) as unknown as Array<{ from_path: string; to_path: string; status_code: number }>;
    expect(rows).toEqual([
      { from_path: "/alt-pfad/artikel.html", to_path: "/issue196-artikel", status_code: 301 },
    ]);

    // Re-compose: pages are accepted now, so nothing re-runs — but a
    // FRESH run over the same source must upsert, not duplicate.
    const runId2 = await seedRun();
    const r2 = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
      runId: runId2,
      templateSlug: "issue196-tpl2",
    });
    if (!r2.ok) throw new Error(JSON.stringify(r2.error));
    const after = (await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`SELECT count(*)::int AS n FROM redirects WHERE from_path = '/alt-pfad/artikel.html'`;
    })) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(1);
  });

  it("fails loudly when the redirect would shadow a LIVE page", async () => {
    // A real page living at the old path.
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx`SELECT id FROM templates WHERE deleted_at IS NULL LIMIT 1`;
      await tx`
        INSERT INTO pages (slug, locale, title, name, status, template_id, version)
        VALUES ('issue196-besetzt', 'en', 'Besetzt', 'Besetzt', 'draft', ${(tpl as unknown as { id: string }[])[0]?.id}::uuid, 1)
        ON CONFLICT DO NOTHING
      `;
    });
    const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
      sourceUrl: "https://issue196.example/",
      depth: 1,
      maxPages: 5,
    });
    const runId = (run.value as { runId: string }).runId;
    await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
      runId,
      pages: [
        {
          sourceUrl: "https://issue196.example/issue196-besetzt",
          proposedSlug: "issue196-anders",
          proposedTitle: "Anders",
          proposedModules: [],
          proposedThemeTokens: {},
          signature: "/x/*|b",
        },
      ],
    });
    await execute(registry, adapter, SYSTEM, "imports.update_run_status", {
      runId,
      status: "ready_for_review",
      pagesSeen: 1,
      pagesExtracted: 1,
    });
    const r = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
      runId,
      templateSlug: "issue196-tpl3",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = JSON.stringify(r.error);
      expect(msg).toContain("would shadow");
      expect(msg).toContain("change_page_slug");
    }
  });
});
