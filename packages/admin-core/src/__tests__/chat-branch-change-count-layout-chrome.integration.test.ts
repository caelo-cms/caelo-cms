// SPDX-License-Identifier: MPL-2.0

/**
 * v0.8.0 — chat.branch_change_count must count layout_modules.set
 * snapshots (op_kind='layout_modules.set' with empty entities[]).
 * Pre-v0.8 the count summed only the entity-snapshot tables; layout-
 * chrome edits had no entry there so the toolbar pill silently said
 * "no pending changes" while real unstaged work sat on the branch.
 *
 * Scenario: create a layout from within a chat branch (which emits a
 * layout_modules.set snapshot). The count must reflect the change,
 * surfaced under byKind.layoutChrome.
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

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "v080-chrome-";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${PFX}%`}`;
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

describe("chat.branch_change_count layoutChrome term (v0.8.0)", () => {
  it("counts layout_modules.set snapshots that have empty entities[]", async () => {
    const sysCtx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "count-test",
    };
    const c = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}c1`,
    });
    if (!c.ok) throw new Error("seed chat");
    const { chatSessionId, chatBranchId } = c.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // Create a layout on the chat branch → emits one site_snapshots
    // row with op_kind='layout_modules.set', entities=[].
    const branchCtx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "layout-create",
      chatBranchId,
    };
    const layoutRes = await execute(registry, adapter, branchCtx, "layouts.create", {
      slug: `${PFX}site`,
      displayName: "Site",
      html: '<body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot><caelo-slot name="footer"></caelo-slot></body>',
      css: "",
      blocks: [
        { name: "header", displayName: "Header", position: 0 },
        { name: "content", displayName: "Content", position: 1 },
        { name: "footer", displayName: "Footer", position: 2 },
      ],
    });
    expect(layoutRes.ok).toBe(true);

    const countRes = await execute(registry, adapter, sysCtx, "chat.branch_change_count", {
      chatSessionId,
    });
    expect(countRes.ok).toBe(true);
    if (!countRes.ok) return;
    const v = countRes.value as {
      count: number;
      byKind: { layoutChrome: number };
    };
    // layouts.create emits exactly one layout_modules.set snapshot.
    expect(v.byKind.layoutChrome).toBe(1);
    expect(v.count).toBeGreaterThanOrEqual(1);
  });
});
