// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — `pages.search` finds pages by the start of their words, as the
 * caller's view shows them, through the word tables of migration 0612: the
 * last word names the page itself, earlier words may match its path; a
 * chat finds the pages it renamed or created by their pending titles and
 * no longer finds the ones it deleted, while main keeps its own view; the
 * search pages through every match with `nextCursor`; and the rebuild op
 * finds the triggers exact.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { listPagesTool } from "../ai/tools/list-pages.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "page-search",
};
// Letters only: the prefix is one search word of every slug.
const PFX = `ps${Date.now().toString(36).replace(/[0-9]/g, "")}x`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

type Found = { id: string; currentPath: string; title: string };

async function ok<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function page(slug: string, title: string, parentPageId?: string): Promise<string> {
  return (
    await ok<{ pageId: string }>(SYSTEM, "pages.create", {
      slug,
      title,
      templateId,
      ...(parentPageId ? { parentPageId } : {}),
    })
  ).pageId;
}

/** Every match of `query`, through `nextCursor`. */
async function search(ctx: ExecutionContext, query: string, limit = 50): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const r: { pages: Found[]; nextCursor: string | null } = await ok(ctx, "pages.search", {
      query,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...r.pages.map((p) => p.id));
    cursor = r.nextCursor;
  } while (cursor !== null);
  return [...new Set(ids)].sort();
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await ok<{ templateId: string }>(SYSTEM, "templates.create", {
      pageType: "home",
      slug: `${PFX}-tpl`,
      displayName: `${PFX} TPL`,
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await ok(SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await adapter.close();
});

describe("#1269 — pages.search by word prefix", () => {
  it("the last word names the page itself, earlier words may match its path", async () => {
    const products = await page(`${PFX}-products`, `${PFX} Products`);
    const shoes = await page(`${PFX}-shoes`, "Running shoes", products);
    const contact = await page(`${PFX}-contact`, "Contact us");

    expect(await search(SYSTEM, "Running sho")).toEqual([shoes]);
    // Both words of the path: the last names the page, the first its parent.
    expect(await search(SYSTEM, `${PFX}-products shoes`)).toEqual([shoes]);
    // The parent's word alone finds the parent, not every page below it.
    expect(await search(SYSTEM, `${PFX} produ`)).toEqual([products]);
    // Words start a word: "ontact" is inside one, not at its start.
    expect(await search(SYSTEM, "ontact")).not.toContain(contact);
    expect(await search(SYSTEM, "CONTACT US")).toContain(contact);
    // Punctuation only: no word, no page.
    expect(await search(SYSTEM, " -/ ")).toEqual([]);
  });

  it("a chat finds what it renamed or created, not what it deleted; main keeps its view", async () => {
    const renamed = await page(`${PFX}-old-name`, "Quarterly report");
    const gone = await page(`${PFX}-gone`, "Obsolete flyer");
    const chat = await ok<{ chatSessionId: string; chatBranchId: string }>(
      SYSTEM,
      "chat.create_session",
      { title: `${PFX}-chat` },
    );
    const ai: ExecutionContext = {
      actorId: SYSTEM.actorId,
      actorKind: "ai",
      requestId: `${PFX}-ai`,
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    // The short title is a page's own word source too: renamed with it.
    await ok(ai, "pages.update", {
      pageId: renamed,
      title: "Annual summary",
      shortTitle: "Annual summary",
    });
    await ok(ai, "pages.delete", { pageId: gone });
    const created = (
      await ok<{ pageId: string }>(ai, "pages.create", {
        slug: `${PFX}-fresh`,
        title: "Brandnew landing",
        templateId,
      })
    ).pageId;

    expect(await search(ai, "annual summ")).toEqual([renamed]);
    expect(await search(ai, "quarterly")).not.toContain(renamed);
    expect(await search(SYSTEM, "quarterly")).toEqual([renamed]);
    expect(await search(SYSTEM, "annual summ")).not.toContain(renamed);

    expect(await search(ai, "obsolete")).not.toContain(gone);
    expect(await search(SYSTEM, "obsolete")).toEqual([gone]);

    expect(await search(ai, "brandnew")).toEqual([created]);
    expect(await search(SYSTEM, "brandnew")).not.toContain(created);
  });

  it("pages through every match with nextCursor and refuses a cursor it did not issue", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) ids.push(await page(`${PFX}-many-${i}`, `Pagingword ${i}`));
    const first = await ok<{ pages: Found[]; nextCursor: string | null }>(SYSTEM, "pages.search", {
      query: "pagingw",
      limit: 3,
    });
    expect(first.pages).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    expect(await search(SYSTEM, "pagingw", 3)).toEqual([...ids].sort());

    const forged = await execute(registry, adapter, SYSTEM, "pages.search", {
      query: "pagingw",
      cursor: "bm90LWEtY3Vyc29y",
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(JSON.stringify(forged.error)).toContain("nextCursor");
    const listCursor = await ok<{ nextCursor: string | null }>(SYSTEM, "pages.list", { limit: 1 });
    const crossed = await execute(registry, adapter, SYSTEM, "pages.search", {
      query: "pagingw",
      cursor: listCursor.nextCursor,
    });
    expect(crossed.ok).toBe(false);
  });

  it("never skips a page between two words of another page that match the same prefix", async () => {
    // Candidates in word order: (…shop, a), (…shopper, b), (…shopping, a).
    // With limit 1 the first call takes a; the next must still reach b.
    const a = await page(`${PFX}-dup-a`, `${PFX}shop ${PFX}shopping`);
    const b = await page(`${PFX}-dup-b`, `${PFX}shopper`);
    expect(await search(SYSTEM, `${PFX}shop`, 1)).toEqual([a, b].sort());
  });

  it("refuses a cursor of another query", async () => {
    for (let i = 0; i < 3; i += 1) await page(`${PFX}-bound-${i}`, `Boundword ${i}`);
    const first = await ok<{ nextCursor: string | null }>(SYSTEM, "pages.search", {
      query: "boundw",
      limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    const other = await execute(registry, adapter, SYSTEM, "pages.search", {
      query: "other boundw",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(JSON.stringify(other.error)).toContain("another query");
  });

  it("pages another chat created or a delete removed take no candidate's place", async () => {
    // 600 rows the caller cannot see, all before the visible page in word
    // order: they must not use up the call's 500 candidates.
    const elsewhere = await ok<{ chatBranchId: string }>(SYSTEM, "chat.create_session", {
      title: `${PFX}-elsewhere`,
      isolation: "experiment",
    });
    await adapter.withAdminTransaction(SYSTEM, (tx) =>
      tx.execute(sql`
        INSERT INTO pages (slug, title, short_title, template_id, current_path, status,
                           chat_branch_id, deleted_at)
        SELECT ${`${PFX}-hidden-`} || i, ${`${PFX}hid`}, ${`${PFX}hid`}, ${templateId}::uuid,
               ${`/${PFX}-hidden-`} || i, 'draft',
               CASE WHEN i % 2 = 0 THEN ${elsewhere.chatBranchId}::uuid END,
               CASE WHEN i % 2 = 1 THEN now() END
          FROM generate_series(1, 600) i`),
    );
    const visible = await page(`${PFX}-shown`, `${PFX}hidz`);
    const r = await ok<{ pages: Found[] }>(SYSTEM, "pages.search", { query: `${PFX}hid` });
    expect(r.pages.map((p) => p.id)).toEqual([visible]);
  });

  it("the rebuild finds the triggers exact", async () => {
    const r = await ok<{ rows: number; drift: { missing: number; extra: number } }>(
      SYSTEM,
      "pages.rebuild_search_words",
      {},
    );
    expect(r.drift).toEqual({ missing: 0, extra: 0 });
    expect(r.rows).toBeGreaterThan(0);
  });

  it("list_pages searches with pages.search and pages through the site with a cursor", async () => {
    const tool = (input: Parameters<typeof listPagesTool.handler>[1]) =>
      listPagesTool.handler(SYSTEM, input, {
        registry,
        adapter,
      } as unknown as Parameters<typeof listPagesTool.handler>[2]);
    const found = await page(`${PFX}-tool-find`, "Quokkaword landing");
    const hit = await tool({ search: "quokkaword lan" });
    expect(hit.ok).toBe(true);
    expect(hit.content).toContain(found);
    expect(hit.content).toStartWith("pages[1]");

    const miss = await tool({ search: "uokkaword" });
    expect(miss.content).toContain('No page matches "uokkaword"');

    // One page of the site at a time, continued by the cursor it names.
    const first = await tool({ limit: 2 });
    const cursor = /next cursor: (\S+)/.exec(first.content)?.[1];
    expect(first.content).toStartWith("pages[2]");
    expect(cursor).toBeDefined();
    const second = await tool({ limit: 2, cursor });
    expect(second.ok).toBe(true);
    // The id column (second) of each TOON row.
    const ids = (text: string) =>
      text
        .split("\n")
        .filter((l) => l.startsWith("  "))
        .map((l) => l.trim().split(",")[1] ?? "");
    expect(ids(second.content).some((id) => ids(first.content).includes(id))).toBe(false);

    // A batch a chat's pending deletes emptied still names the cursor on.
    const chat = await ok<{ chatSessionId: string; chatBranchId: string }>(
      SYSTEM,
      "chat.create_session",
      { title: `${PFX}-tool-chat` },
    );
    const ai: ExecutionContext = {
      actorId: SYSTEM.actorId,
      actorKind: "ai",
      requestId: `${PFX}-tool-ai`,
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    const oldest = await ok<{ pages: { id: string }[] }>(ai, "pages.list", { limit: 1 });
    const oldestId = oldest.pages[0]?.id ?? "";
    await ok(ai, "pages.delete", { pageId: oldestId, children: "move-up" });
    const emptied = await listPagesTool.handler(ai, { limit: 1 }, {
      registry,
      adapter,
    } as unknown as Parameters<typeof listPagesTool.handler>[2]);
    expect(emptied.content).toContain("No visible page in this batch; call again with cursor:");

    // Long titles: a call stays under the list char cap, and its cursor
    // continues right after the last row it showed (every page once).
    const parent = await page(`${PFX}-long-parent`, "Long parent");
    const children: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      children.push(await page(`${PFX}-long-${i}`, `${"Lengthy title ".repeat(14)}${i}`, parent));
    }
    const seen: string[] = [];
    let next: string | undefined;
    let calls = 0;
    do {
      const r = await tool({ underPageId: parent, limit: 200, ...(next ? { cursor: next } : {}) });
      expect(r.content.length).toBeLessThan(7000);
      seen.push(...ids(r.content));
      next = /next cursor: (\S+)/.exec(r.content)?.[1];
      calls += 1;
    } while (next);
    expect(calls).toBeGreaterThan(1);
    expect([...seen].sort()).toEqual([...children].sort());

    const both = await tool({ search: "quokkaword", underPageId: found });
    expect(both.ok).toBe(false);
    expect(both.content).toContain("cannot be combined");
  });
});
