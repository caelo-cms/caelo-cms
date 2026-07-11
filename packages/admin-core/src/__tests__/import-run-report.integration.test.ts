// SPDX-License-Identifier: MPL-2.0

/**
 * issue #197 — notes append across passes, categories are typed at
 * the boundary, and the run report rolls up clusters, redirects
 * (same rule as the #196 compose tx), crawl errors, and the
 * applied/suggested note split.
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
let runId: string;
let pageAId: string;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue197-report",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue197-report-sys",
};

async function cleanup(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM import_pages WHERE source_url LIKE 'https://issue197.example%'`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE 'https://issue197.example%'`;
    await tx`DELETE FROM pages WHERE slug = 'issue197-anchor'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL!);
  await cleanup();

  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: "https://issue197.example/",
    depth: 1,
    maxPages: 10,
  });
  runId = (run.value as { runId: string }).runId;
  await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      {
        sourceUrl: "https://issue197.example/alte-seite.html",
        proposedSlug: "issue197-a",
        proposedTitle: "A",
        proposedModules: [],
        proposedThemeTokens: {},
        signature: "/x/*|s1",
      },
      {
        sourceUrl: "https://issue197.example/issue197-b",
        proposedSlug: "issue197-b",
        proposedTitle: "B",
        proposedModules: [],
        proposedThemeTokens: {},
        signature: "/x/*|s1",
      },
    ],
  });
  // Simulate #192's finished-run state slice + #196's acceptance.
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`UPDATE import_runs SET crawl_state = ${JSON.stringify({
      errors: [{ url: "https://issue197.example/kaputt", reason: "non-OK status" }],
    })}::jsonb WHERE id = ${runId}::uuid`;
    // accepted_page_id has an FK to pages — mint a real page to point
    // at (the shared dev DB may have zero pages between suites).
    const anchor = await tx`
      INSERT INTO pages (slug, locale, title, name, status, template_id, version)
      SELECT 'issue197-anchor', 'en', 'Anchor', 'Anchor', 'draft', id, 1
      FROM templates WHERE deleted_at IS NULL LIMIT 1
      RETURNING id
    `;
    const anchorId = (anchor as unknown as { id: string }[])[0]?.id;
    if (!anchorId) throw new Error("no template available to anchor the test page");
    await tx`UPDATE import_pages
             SET accepted_page_id = ${anchorId}::uuid,
                 cluster_label = 'Inhalt'
             WHERE run_id = ${runId}::uuid`;
    const rows =
      await tx`SELECT id::text AS id FROM import_pages WHERE run_id = ${runId}::uuid AND source_url LIKE '%alte-seite%'`;
    pageAId = (rows as unknown as { id: string }[])[0]?.id ?? "";
  });
});

afterAll(async () => {
  await cleanup();
  await sqlc.end();
  await adapter.close();
});

describe("migration report (#197)", () => {
  it("notes append across calls and reject unknown categories", async () => {
    const first = await execute(registry, adapter, AI, "imports.add_page_notes", {
      importPageId: pageAId,
      notes: [
        { category: "typo", note: "'Adresse' war 'Addresse' — korrigiert", applied: true },
        { category: "dead_link", note: "/impressum-alt existiert nicht mehr", applied: false },
      ],
    });
    expect(first.ok).toBe(true);
    const second = await execute(registry, adapter, AI, "imports.add_page_notes", {
      importPageId: pageAId,
      notes: [{ category: "missing_alt", note: "Teambild ohne Alt-Text — ergänzt", applied: true }],
    });
    expect(second.ok).toBe(true);
    expect((second.value as { totalNotes: number }).totalNotes).toBe(3);

    const bad = await execute(registry, adapter, AI, "imports.add_page_notes", {
      importPageId: pageAId,
      notes: [{ category: "vibes", note: "x", applied: false }],
    });
    expect(bad.ok).toBe(false);
  });

  it("report rolls up clusters, redirects, crawl errors, and the applied/suggested split", async () => {
    const r = await execute(registry, adapter, AI, "imports.get_run_report", { runId });
    expect(r.ok).toBe(true);
    const v = r.value as {
      acceptedPages: number;
      clusters: { label: string | null; count: number }[];
      redirectsCreated: number;
      crawlErrors: { url: string; reason: string }[];
      notes: { category: string; applied: number; suggested: number }[];
    };
    expect(v.acceptedPages).toBe(2);
    expect(v.clusters).toEqual([{ clusterKey: "/x/*|s1", label: "Inhalt", count: 2 }]);
    // Only alte-seite.html differs from its Caelo path.
    expect(v.redirectsCreated).toBe(1);
    expect(v.crawlErrors).toEqual([
      { url: "https://issue197.example/kaputt", reason: "non-OK status" },
    ]);
    const typo = v.notes.find((n) => n.category === "typo");
    const dead = v.notes.find((n) => n.category === "dead_link");
    expect(typo).toMatchObject({ applied: 1, suggested: 0 });
    expect(dead).toMatchObject({ applied: 0, suggested: 1 });
  });
});
