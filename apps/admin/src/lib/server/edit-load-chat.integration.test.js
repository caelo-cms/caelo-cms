// SPDX-License-Identifier: MPL-2.0
/**
 * #1201 — the /edit loader always opens a chat the operator can use for the
 * page. An archived or discarded chat of theirs and another editor's open
 * chat do not keep them out; their own open chat is resumed, also when the
 * loader's session list does not reach it — the per-page gate's refusal is
 * never the dead end it was (HTTP 500 on searchviu.com's home page).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execute } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { load } from "../../routes/(authed)/edit/+page.server.js";
import { getQueryContext } from "./query.js";
const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL)
    throw new Error("ADMIN_DATABASE_URL required");
const TS = Date.now().toString(36);
const PFX = `e1201-${TS}-`;
const SYSTEM = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system",
    requestId: "e1201",
};
async function asSystem(query) {
    const sql = new SQL(ADMIN_URL);
    try {
        return (await sql.begin(async (tx) => {
            await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
            return query(tx);
        }));
    }
    finally {
        await sql.end();
    }
}
async function op(ctx, name, input) {
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, ctx, name, input);
    if (!r.ok)
        throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return r.value;
}
/** A human editor with their own actor row (chat_sessions.created_by FK). */
async function editor(label) {
    const id = crypto.randomUUID();
    await asSystem((tx) => tx `INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${PFX + label})`);
    return { actorId: id, actorKind: "human", requestId: `e1201-${label}` };
}
let templateId = "";
async function seedPage(slug) {
    const { pageId } = await op(SYSTEM, "pages.create", {
        slug: `${PFX}${slug}`,
        title: slug,
        templateId,
    });
    return pageId;
}
async function pageChat(ctx, pageId, title) {
    return (await op(ctx, "chat.create_session", {
        title: `${PFX}${title}`,
        pageId,
    })).chatSessionId;
}
/** Runs the real /edit loader as `ctx` for `pageId`; returns the chat it opened. */
async function openLiveEdit(ctx, pageId) {
    const event = {
        locals: {
            user: { permissions: new Set(["content.write", "content.read"]) },
            ctx,
        },
        url: new URL(`http://admin.test/edit?page=${pageId}`),
        setHeaders: () => { },
    };
    const data = (await load(event));
    // #1268 — the parts that stream after first paint settle with a value
    // (and finish before the test closes the pool).
    for (const key of STREAMED) {
        const part = (await data[key]);
        expect({ key, ...part }).toMatchObject({ key, ok: true });
    }
    return data.activeChat;
}
/** The streamed parts of the /edit load (#1268). */
const STREAMED = [
    "pages",
    "recentPageIds",
    "modules",
    "branchEditedModuleIds",
    "branchChangeCount",
    "pendingChanges",
    "otherOpenChats",
    "deployState",
    "live",
    "pageSeo",
];
beforeAll(async () => {
    ({ templateId } = await op(SYSTEM, "templates.create", {
        pageType: "home",
        slug: `${PFX}tpl`,
        displayName: "T",
        html: '<body><caelo-slot name="content">_</caelo-slot></body>',
    }));
});
afterAll(async () => {
    await getQueryContext().adapter.close();
});
describe("#1201 — /edit opens a usable chat for the page", () => {
    it("is not blocked by the operator's archived chat on the page", async () => {
        const me = await editor("archived");
        const pageId = await seedPage("archived");
        const archived = await pageChat(me, pageId, "archived");
        await op(me, "chat.archive_session", { chatSessionId: archived });
        const chat = await openLiveEdit(me, pageId);
        expect(chat.id).not.toBe(archived);
        expect(chat.createdBy).toBe(me.actorId);
        expect(chat.pageId).toBe(pageId);
    });
    it("is not blocked by another editor's open chat on the page", async () => {
        const alice = await editor("alice");
        const bob = await editor("bob");
        const pageId = await seedPage("shared");
        const alices = await pageChat(alice, pageId, "alice");
        const chat = await openLiveEdit(bob, pageId);
        expect(chat.id).not.toBe(alices);
        expect(chat.createdBy).toBe(bob.actorId);
    });
    it("opens the ?page= page at first paint without the page list (#1268)", async () => {
        const me = await editor("first-paint");
        const pageId = await seedPage("first-paint");
        let headers = {};
        const event = {
            locals: { user: { permissions: new Set(["content.write", "content.read"]) }, ctx: me },
            url: new URL(`http://admin.test/edit?page=${pageId}`),
            setHeaders: (h) => {
                headers = h;
            },
        };
        const data = (await load(event));
        expect(data.activePage?.id).toBe(pageId);
        expect(data.pages).toBeInstanceOf(Promise);
        const pages = await data.pages;
        expect(pages.ok).toBe(true);
        expect(pages.value?.some((p) => p.id === pageId)).toBe(true);
        expect(headers["server-timing"]).toMatch(/page-main;dur=.*chats;dur=/);
        for (const key of STREAMED)
            await data[key];
    });
    it("resumes the operator's open chat on the page", async () => {
        const me = await editor("open");
        const pageId = await seedPage("open");
        const open = await pageChat(me, pageId, "open");
        expect((await openLiveEdit(me, pageId)).id).toBe(open);
    });
    it("resumes the open chat the gate refuses for even when the session list misses it", async () => {
        const me = await editor("crowded");
        const pageId = await seedPage("crowded");
        const open = await pageChat(me, pageId, "open");
        // 100 published chats on the page, all more recently active: the
        // loader's `chat.list_sessions` (100 rows) no longer reaches the open
        // one, so it tries to create a chat and the per-page gate refuses.
        await asSystem((tx) => tx `
        INSERT INTO chat_sessions (title, created_by, chat_branch_id, branch_kind, page_id, published_at, last_active_at)
        SELECT ${`${PFX}published`}, ${me.actorId}::uuid, gen_random_uuid(), 'experiment', ${pageId}::uuid,
               now(), now() + (g || ' seconds')::interval
        FROM generate_series(1, 100) g`);
        expect((await openLiveEdit(me, pageId)).id).toBe(open);
    });
});
