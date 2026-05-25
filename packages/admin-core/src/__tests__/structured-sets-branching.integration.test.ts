// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.3 — branched structured_sets writes.
 *
 * When ctx.chatBranchId is set:
 *   - structured_sets.set does NOT update live `items`.
 *   - A structured_set_snapshots row lands tagged with the branch.
 *   - chat.publish materialises the staged blob into live.
 *
 * The pre-v0.5.3 behaviour overwrote `items` unconditionally; two
 * chats editing the same structured-set stepped on each other live.
 * This pins the isolation guarantee.
 *
 * v0.11.0 (#45) — theme is no longer a structured-set kind; the
 * branched-write semantics are identical for the surviving kinds
 * (nav-menu, taxonomy, tags, link-list, language-selector), so this
 * test now uses nav-menu. The theme primitive's own branched-write
 * isolation is exercised by the v0.11.0 themes integration suite.
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

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "v053-ss",
};

const SET_SLUG = "v053-nav-menu";
const SESSION_TITLE = "v053-ss-session";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'v053-ss-%'`;
      await tx`DELETE FROM structured_sets WHERE slug = ${SET_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("structured_sets branched writes (v0.5.3)", () => {
  it("branched nav-menu write skips live items + lands a branched snapshot; publish merges", async () => {
    // Seed the nav-menu in main with one item. v0.11.0 (#45) — theme
    // moved out of structured_sets; the branched-write semantics are
    // identical across the surviving kinds, so this test pins the
    // isolation guarantee on nav-menu instead.
    const seed = await execute(registry, adapter, HUMAN, "structured_sets.set", {
      kind: "nav-menu",
      slug: SET_SLUG,
      displayName: "Test Menu",
      items: [{ label: "Home", href: "/" }],
    });
    if (!seed.ok) throw new Error("seed");
    const setId = (seed.value as { setId: string }).setId;

    // Create a chat session to give us a branch.
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: SESSION_TITLE,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // Branched write — different items.
    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "v053-ss-ai",
      chatBranchId,
    };
    const branchedWrite = await execute(registry, adapter, aiCtx, "structured_sets.set", {
      kind: "nav-menu",
      slug: SET_SLUG,
      displayName: "Test Menu",
      items: [{ label: "Branched Home", href: "/" }],
    });
    expect(branchedWrite.ok).toBe(true);

    // Live row still carries the SEED items, not the branched ones.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const liveRows = (await tx`
          SELECT items::text AS items FROM structured_sets WHERE id = ${setId}::uuid
        `) as unknown as { items: string }[];
        const liveItems = JSON.parse(liveRows[0]?.items ?? "[]") as { label: string }[];
        expect(liveItems[0]?.label).toBe("Home");

        // Branched snapshot reflects the new value.
        const snapRows = (await tx`
          SELECT sss.state FROM structured_set_snapshots sss
          JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
          WHERE sss.structured_set_id = ${setId}::uuid
            AND ss.chat_branch_id = ${chatBranchId}::uuid
          ORDER BY ss.created_at DESC LIMIT 1
        `) as unknown as { state: string | { items: { label: string }[] } }[];
        const raw = snapRows[0]?.state;
        const state =
          typeof raw === "string"
            ? (JSON.parse(raw) as { items: { label: string }[] })
            : (raw as { items: { label: string }[] });
        expect(state.items[0]?.label).toBe("Branched Home");
      });
    } finally {
      await sql.end();
    }

    // Publish merges branched items into live.
    const pub = await execute(registry, adapter, HUMAN, "chat.publish", {
      chatSessionId,
    });
    expect(pub.ok).toBe(true);

    const sql2 = new SQL(ADMIN_URL!);
    try {
      await sql2.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const liveAfter = (await tx`
          SELECT items::text AS items FROM structured_sets WHERE id = ${setId}::uuid
        `) as unknown as { items: string }[];
        const liveItems = JSON.parse(liveAfter[0]?.items ?? "[]") as { label: string }[];
        expect(liveItems[0]?.label).toBe("Branched Home");
      });
    } finally {
      await sql2.end();
    }
  });
});
