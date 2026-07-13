// SPDX-License-Identifier: MPL-2.0

/**
 * Run #9 R9 regression — a page deleted from a chat DISAPPEARS from
 * `pages.list` for that chat.
 *
 * `pages.delete` in branched mode (every chat runs on a branch) emits a
 * page_snapshots row with `deletedAt` and leaves the live row untouched
 * until publish. Pre-fix, `pages.list` only filtered the live
 * `deleted_at` column, so the deleted page kept appearing in the AI's
 * own list, the `## Pages` context block, and the /edit sidebar (which
 * lists with the chat's branch ctx) — the run #9 operator verified the
 * "deleted" page visible three times. The fix overlays the latest
 * branched page snapshot per page onto the list read.
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

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "run9-r9",
};

const TPL_SLUG = "run9-del-tpl";
const PAGE_SLUG = "run9-del-pg";
const SESSION_TITLE = "run9-del-session";

async function wipe(): Promise<void> {
  const sqlc = new SQL(ADMIN_URL as string);
  try {
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE title = ${SESSION_TITLE}`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sqlc.end();
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

describe("run #9 R9 — branched pages.delete reads back as deleted", () => {
  it("the deleted page disappears from pages.list on the chat branch and from main after merge", async () => {
    const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
      slug: TPL_SLUG,
      displayName: "Run9 delete tpl",
      html: "<main>{{content}}</main>",
      css: "",
    });
    if (!tpl.ok) throw new Error(JSON.stringify(tpl.error));
    const templateId = (tpl.value as { templateId: string }).templateId;

    const page = await execute(registry, adapter, SYSTEM, "pages.create", {
      slug: PAGE_SLUG,
      locale: "en",
      title: "Run9 deletable page",
      templateId,
      status: "draft",
    });
    if (!page.ok) throw new Error(JSON.stringify(page.error));
    const pageId = (page.value as { pageId: string }).pageId;

    const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: SESSION_TITLE,
    });
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "run9-r9-ai",
      chatBranchId,
    };

    const del = await execute(registry, adapter, aiCtx, "pages.delete", { pageId });
    expect(del.ok).toBe(true);

    // The chat's own read view: gone (this is what run #9 saw broken —
    // pages.list returned the page unchanged after a successful delete).
    const branchList = await execute(registry, adapter, aiCtx, "pages.list", {});
    if (!branchList.ok) throw new Error(JSON.stringify(branchList.error));
    const branchIds = (branchList.value as { pages: { id: string }[] }).pages.map((p) => p.id);
    expect(branchIds).not.toContain(pageId);

    // includeDeleted surfaces it WITH the branched deletedAt.
    const branchListAll = await execute(registry, adapter, aiCtx, "pages.list", {
      includeDeleted: true,
    });
    if (!branchListAll.ok) throw new Error(JSON.stringify(branchListAll.error));
    const deletedRow = (
      branchListAll.value as { pages: { id: string; deletedAt: string | null }[] }
    ).pages.find((p) => p.id === pageId);
    expect(deletedRow).toBeDefined();
    expect(deletedRow?.deletedAt).not.toBeNull();

    // Branch isolation stands: main (no branch ctx) still shows the
    // page until the chat publishes.
    const mainList = await execute(registry, adapter, SYSTEM, "pages.list", {});
    if (!mainList.ok) throw new Error(JSON.stringify(mainList.error));
    expect((mainList.value as { pages: { id: string }[] }).pages.map((p) => p.id)).toContain(
      pageId,
    );

    // Publish: the branched delete lands on the live row and the page
    // disappears from main too (the admin pages routes read this op).
    const merge = await execute(registry, adapter, SYSTEM, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merge.ok).toBe(true);
    const mainAfter = await execute(registry, adapter, SYSTEM, "pages.list", {});
    if (!mainAfter.ok) throw new Error(JSON.stringify(mainAfter.error));
    expect((mainAfter.value as { pages: { id: string }[] }).pages.map((p) => p.id)).not.toContain(
      pageId,
    );
  });
});
