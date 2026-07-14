// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — per-page edit log ops against the real DB: append + list
 * round-trip (newest-first, jsonb detail preserved as an object, chat origin
 * left null off-branch), the fail-loud path for a non-existent page, and the
 * open read scope. Runs in CI only (needs the two Postgres URLs).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, PageLogEntry } from "@caelo-cms/shared";
import { pageLogEntrySchema } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000264a1",
  actorKind: "ai",
  requestId: "issue-264-page-log-test",
};
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000264b1",
  actorKind: "human",
  requestId: "issue-264-page-log-test-human",
};

const TEMPLATE_ID = "00000000-0000-0000-0000-0000002640c1";
const PAGE_ID = "00000000-0000-0000-0000-0000002640d1";
const MISSING_PAGE_ID = "00000000-0000-0000-0000-0000002640ff";

beforeAll(async () => {
  registry = new OperationRegistry();
  registerAdminOps(registry);
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL as string,
    publicDatabaseUrl: PUBLIC_URL as string,
  });
  sqlc = new SQL(ADMIN_URL as string);
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`
      INSERT INTO actors (id, kind, display_name) VALUES
        (${AI.actorId}::uuid, 'ai', 'issue-264 page-log ai'),
        (${HUMAN.actorId}::uuid, 'human', 'issue-264 page-log human')
      ON CONFLICT (id) DO NOTHING
    `;
    // templates.layout_id is NOT NULL (layout binding is mandatory) — bind
    // the CI-seeded site-default layout, same as the other integration
    // fixtures (content-rls, preview-render-list-iteration).
    await tx`
      INSERT INTO templates (id, slug, display_name, html, layout_id)
      VALUES (${TEMPLATE_ID}::uuid, 'issue-264-page-log-tpl', 'issue-264 tpl', '<main></main>',
              (SELECT id FROM layouts WHERE slug = 'site-default'))
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO pages (id, slug, locale, title, template_id)
      VALUES (${PAGE_ID}::uuid, 'issue-264-page-log', 'en', 'issue-264 page', ${TEMPLATE_ID}::uuid)
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sqlc.end({ timeout: 5 }).catch(() => {});
  await adapter.close?.();
});

describe("page_log ops (issue #264)", () => {
  it("fails loudly when the page does not exist", async () => {
    const r = await execute(registry, adapter, AI, "page_log.append", {
      pageId: MISSING_PAGE_ID,
      entryKind: "note",
      summary: "should not land",
    });
    expect(r.ok).toBe(false);
  });

  it("appends entries and lists them newest-first with jsonb detail preserved", async () => {
    const first = await execute(registry, adapter, AI, "page_log.append", {
      pageId: PAGE_ID,
      entryKind: "decision",
      summary: "Two-column hero to match the source.",
      detail: { chosen: "two-column", moduleIds: ["m1", "m2"] },
    });
    expect(first.ok).toBe(true);
    expect((first.value as { entryId: string }).entryId).toMatch(/[0-9a-f-]{36}/);

    // Human actor can append too (ungated, cross-actor shared log).
    const second = await execute(registry, adapter, HUMAN, "page_log.append", {
      pageId: PAGE_ID,
      entryKind: "operator_answer",
      summary: "Keep the original blue.",
    });
    expect(second.ok).toBe(true);

    const listed = await execute(registry, adapter, AI, "page_log.list", { pageId: PAGE_ID });
    expect(listed.ok).toBe(true);
    const entries = (listed.value as { entries: PageLogEntry[] }).entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Output validates against the shared schema (no drift op↔schema).
    for (const e of entries) expect(pageLogEntrySchema.safeParse(e).success).toBe(true);

    // Newest-first: the operator_answer (appended last) leads.
    expect(entries[0]?.entryKind).toBe("operator_answer");
    expect(entries[0]?.actorKind).toBe("human");

    const decision = entries.find((e) => e.entryKind === "decision");
    expect(decision?.detail).toEqual({ chosen: "two-column", moduleIds: ["m1", "m2"] });
    // Off a chat branch, chat origin is null (not spoofable by the caller).
    expect(decision?.chatSessionId).toBeNull();
  });

  it("honours the limit and reads under every actor kind", async () => {
    const limited = await execute(registry, adapter, HUMAN, "page_log.list", {
      pageId: PAGE_ID,
      limit: 1,
    });
    expect(limited.ok).toBe(true);
    expect((limited.value as { entries: PageLogEntry[] }).entries).toHaveLength(1);
  });
});
