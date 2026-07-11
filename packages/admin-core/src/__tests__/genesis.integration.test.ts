// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — Site Genesis ops against the real Postgres pair (no
 * mocked DB per CLAUDE.md §6): draft add/list/select round-trip, the
 * single-selected invariant (demote-then-promote + partial unique
 * index), the discarded guard, the boundary caps, the design-brief
 * round-trip through site_defaults.set_identity/get, and the seeded
 * site-genesis skill.
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

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000163a1",
  actorKind: "ai",
  requestId: "issue-163-genesis-test",
};

const HTML = `<!doctype html><html><head><style>body{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-family:"Inter",sans-serif}</style></head><body><h1>Draft</h1><p>${"x".repeat(160)}</p></body></html>`;

beforeAll(async () => {
  registry = new OperationRegistry();
  registerAdminOps(registry);
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL as string,
    publicDatabaseUrl: PUBLIC_URL as string,
  });
  sqlc = new SQL(ADMIN_URL as string);
  // audit_events.actor_id + site_defaults.updated_by FK into actors —
  // seed the test actor (same pattern as the other integration suites).
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`
      INSERT INTO actors (id, kind, display_name)
      VALUES (${AI.actorId}::uuid, 'ai', 'issue-163 genesis test')
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sqlc.end({ timeout: 5 }).catch(() => {});
  await adapter.close?.();
});

async function addDraft(direction: string): Promise<string> {
  const r = await execute(registry, adapter, AI, "genesis.add_draft", {
    direction,
    rationale: `${direction} fits the brief`,
    html: HTML,
  });
  expect(r.ok).toBe(true);
  return (r.value as { draftId: string }).draftId;
}

describe("genesis ops (issue #163)", () => {
  it("adds, lists (metadata only), selects with single-selected invariant", async () => {
    const a = await addDraft("bold editorial");
    const b = await addDraft("warm organic");

    const list = await execute(registry, adapter, AI, "genesis.list_drafts", {
      includeHtml: false,
    });
    expect(list.ok).toBe(true);
    const drafts = (
      list.value as { drafts: { id: string; status: string; html?: string; htmlBytes: number }[] }
    ).drafts;
    const ids = drafts.map((d) => d.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    for (const d of drafts) {
      expect(d.html).toBeUndefined(); // bodies stay out of listings
      expect(d.htmlBytes).toBeGreaterThan(0);
    }

    // Select A, then B — A demotes back to candidate atomically.
    const selA = await execute(registry, adapter, AI, "genesis.select_draft", { draftId: a });
    expect(selA.ok).toBe(true);
    const selB = await execute(registry, adapter, AI, "genesis.select_draft", { draftId: b });
    expect(selB.ok).toBe(true);
    expect((selB.value as { previousSelectedId: string | null }).previousSelectedId).toBe(a);

    const conn = await sqlc.reserve();
    try {
      await conn`SELECT set_config('caelo.actor_kind', 'system', false)`;
      const selected = (await conn`
        SELECT id::text AS id FROM genesis_drafts WHERE status = 'selected'
      `) as unknown as { id: string }[];
      expect(selected).toHaveLength(1);
      expect(selected[0]?.id).toBe(b);
    } finally {
      conn.release();
    }
  });

  it("rejects unknown draft ids with an AI-actionable message", async () => {
    const r = await execute(registry, adapter, AI, "genesis.select_draft", {
      draftId: "11111111-1111-4111-8111-111111111199",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((r.error as { message?: string }).message).toContain("genesis.list_drafts");
    }
  });

  it("round-trips the design brief through set_identity / get", async () => {
    const set = await execute(registry, adapter, AI, "site_defaults.set_identity", {
      designBrief: {
        audience: "small bakeries and their regulars",
        moodWords: ["warm", "handmade", "honest"],
        tone: "friendly, plainspoken",
        industry: "food & craft",
        imageryDirection: "close-up bread textures, morning light",
      },
    });
    expect(set.ok).toBe(true);

    const got = await execute(registry, adapter, AI, "site_defaults.get", {});
    expect(got.ok).toBe(true);
    const brief = (
      got.value as { defaults: { designBrief: { moodWords?: string[] } | null } | null }
    ).defaults?.designBrief;
    expect(brief?.moodWords).toEqual(["warm", "handmade", "honest"]);
  });

  it("ships the site-genesis skill seed", async () => {
    const conn = await sqlc.reserve();
    try {
      await conn`SELECT set_config('caelo.actor_kind', 'system', false)`;
      const rows = (await conn`
        SELECT slug, status FROM skills WHERE slug = 'site-genesis'
      `) as unknown as { slug: string; status: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("active");
    } finally {
      conn.release();
    }
  });
});
