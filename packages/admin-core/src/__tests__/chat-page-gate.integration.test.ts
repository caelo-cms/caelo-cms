// SPDX-License-Identifier: MPL-2.0

/**
 * issue #1201 — the per-page chat gate in `chat.create_session` holds only a
 * chat the caller can resume: their own, top-level, open one. Before the fix
 * it counted every unpublished chat on the page, so an archived chat, a
 * discarded one, or another operator's chat (all invisible to the caller in
 * `chat.list_sessions`) refused every new page chat, and /edit answered 500
 * because it could neither resume nor create a chat. `chat.list_active_pages`
 * ("New chat" resumes through it) follows the same scope.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;

const MICHAEL: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-000000120101",
  actorKind: "human",
  requestId: "issue-1201-a",
};
const KATJA: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-000000120102",
  actorKind: "human",
  requestId: "issue-1201-b",
};
const TEMPLATE_ID = "00000000-0000-4000-8000-0000001201c1";
const PAGE_ID = "00000000-0000-4000-8000-0000001201d1";
const PFX = "issue-1201-";

async function createPageChat(ctx: ExecutionContext, title: string) {
  return execute(registry, adapter, ctx, "chat.create_session", {
    title: `${PFX}${title}`,
    pageId: PAGE_ID,
  });
}

function chatId(r: Awaited<ReturnType<typeof createPageChat>>): string {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { chatSessionId: string }).chatSessionId;
}

async function activePageChat(ctx: ExecutionContext): Promise<string | undefined> {
  const r = await execute(registry, adapter, ctx, "chat.list_active_pages", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const pages = (r.value as { pages: { pageId: string; chatSessionId: string }[] }).pages;
  return pages.find((p) => p.pageId === PAGE_ID)?.chatSessionId;
}

async function wipeChats(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
  });
}

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
        (${MICHAEL.actorId}::uuid, 'human', 'issue-1201 first editor'),
        (${KATJA.actorId}::uuid, 'human', 'issue-1201 second editor')
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO templates (id, slug, display_name, html, layout_id)
      VALUES (${TEMPLATE_ID}::uuid, 'issue-1201-tpl', 'issue-1201 tpl', '<main></main>',
              (SELECT id FROM layouts WHERE slug = 'site-default'))
      ON CONFLICT (id) DO NOTHING
    `;
    await adoptTemplateIntoHomePageType(tx, TEMPLATE_ID);
    await tx`
      INSERT INTO pages (id, slug, title, template_id, page_type_confirmed)
      VALUES (${PAGE_ID}::uuid, 'issue-1201-page', 'issue-1201 page', ${TEMPLATE_ID}::uuid, true)
      ON CONFLICT (id) DO NOTHING
    `;
  });
  await wipeChats();
});

afterAll(async () => {
  await wipeChats();
  await sqlc.end({ timeout: 5 }).catch(() => {});
  await adapter.close?.();
});

describe("per-page chat gate (issue #1201)", () => {
  it("refuses the caller a second open page chat and points at the first", async () => {
    const first = chatId(await createPageChat(MICHAEL, "own-1"));
    const second = await createPageChat(MICHAEL, "own-2");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe("HandlerError");
    expect(second.error.message).toContain(first);
    expect(await activePageChat(MICHAEL)).toBe(first);
  });

  it("another operator's open page chat does not hold the page", async () => {
    const michaels = await activePageChat(MICHAEL);
    expect(michaels).toBeDefined();
    // The second editor sees none of the first editor's chats, so there is
    // nothing for "New chat" to resume either.
    expect(await activePageChat(KATJA)).toBeUndefined();
    const katjas = chatId(await createPageChat(KATJA, "other-operator"));
    expect(katjas).not.toBe(michaels);
    expect(await activePageChat(KATJA)).toBe(katjas);
  });

  it("an archived page chat releases the page for its owner", async () => {
    await wipeChats();
    const archivedId = chatId(await createPageChat(MICHAEL, "archived"));
    const archived = await execute(registry, adapter, MICHAEL, "chat.archive_session", {
      chatSessionId: archivedId,
    });
    if (!archived.ok) throw new Error(JSON.stringify(archived.error));
    expect(await activePageChat(MICHAEL)).toBeUndefined();
    const fresh = chatId(await createPageChat(MICHAEL, "after-archive"));
    expect(fresh).not.toBe(archivedId);
  });

  it("a discarded page chat releases the page for its owner", async () => {
    await wipeChats();
    const discardedId = chatId(await createPageChat(MICHAEL, "discarded"));
    const discarded = await execute(registry, adapter, MICHAEL, "chat.discard_branch", {
      chatSessionId: discardedId,
      confirmOverlap: true,
    });
    if (!discarded.ok) throw new Error(JSON.stringify(discarded.error));
    expect((discarded.value as { discarded: boolean }).discarded).toBe(true);
    expect(await activePageChat(MICHAEL)).toBeUndefined();
    const fresh = chatId(await createPageChat(MICHAEL, "after-discard"));
    expect(fresh).not.toBe(discardedId);
  });
});
