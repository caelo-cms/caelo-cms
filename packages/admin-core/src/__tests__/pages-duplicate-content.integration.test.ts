// SPDX-License-Identifier: MPL-2.0

/**
 * `pages.duplicate` copies a page's content 1:1 and owns the copy
 * (international-site's `create_variant` mints language variants through
 * it).
 *
 *   - The same module placed several times keeps each placement's own
 *     content in order. The clone-to-placement pairing used to number the
 *     clones by their random UUID, so repeated sections swapped content.
 *   - Content nested in `module` / `module-list` fields is deep-copied:
 *     new rows, same values, so editing the copy's nested sections leaves
 *     the source untouched. The copy used to keep the source's nested
 *     references.
 *   - A duplicate made in a chat copies the page as the chat sees it: the
 *     chat's layout and its draft content edits, nested ones included.
 *   - `placement.fork_content` deep-copies nested content the same way.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "pdup-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let sectionId = "";
let heroId = "";
let cardId = "";
let holderId = "";

type Ref = { moduleId: string; contentInstanceId: string };
type Placement = { blockName: string; position: number; moduleSlug: string; values: unknown };
type Got = { instance: { values: Record<string, unknown> } };

async function run(ctx: ExecutionContext, name: string, input: unknown) {
  return execute(registry, adapter, ctx, name, input);
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await run(ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** Live `page_modules` rows of a page, in render order. */
async function rowsOf(
  pageId: string,
): Promise<
  { block_name: string; position: number; module_id: string; ci: string; sync_mode: string }[]
> {
  const db = new SQL(ADMIN_URL!);
  try {
    return (await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`
        SELECT block_name, position, module_id::text AS module_id,
               content_instance_id::text AS ci, sync_mode
          FROM page_modules WHERE page_id = ${pageId}::uuid
         ORDER BY block_name, position`;
    })) as never;
  } finally {
    await db.end();
  }
}

async function valuesOf(ctx: ExecutionContext, id: string): Promise<Record<string, unknown>> {
  return (await op<Got>(ctx, "content_instances.get", { id })).instance.values;
}

async function placementsOf(ctx: ExecutionContext, pageId: string): Promise<Placement[]> {
  return (
    await op<{ placements: Placement[] }>(ctx, "page_module_content.list_for_page", { pageId })
  ).placements;
}

async function createModule(
  slug: string,
  html: string,
  fields: Record<string, unknown>[],
): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `pdup-${slug}-${TS}`,
      displayName: `PDUP ${slug}`,
      html,
      fields,
    })
  ).moduleId;
}

async function createPage(slug: string, ctx: ExecutionContext = SYS): Promise<string> {
  return (
    await op<{ pageId: string }>(ctx, "pages.create", {
      slug: `pdup-${slug}-${TS}`,
      shortTitle: slug,
      title: slug,
      templateId,
    })
  ).pageId;
}

async function duplicate(ctx: ExecutionContext, sourcePageId: string, slug: string) {
  return (
    await op<{ pageId: string }>(ctx, "pages.duplicate", {
      sourcePageId,
      newSlug: `pdup-${slug}-${TS}`,
    })
  ).pageId;
}

async function instance(moduleId: string, values: Record<string, unknown>): Promise<string> {
  return (
    await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId,
      displayName: `PDUP ${moduleId.slice(0, 6)} ${JSON.stringify(values).slice(0, 20)}`,
      purpose: "test",
      values,
    })
  ).contentInstanceId;
}

/** A new chat on the site's shared draft, as the AI acting in it. */
async function draftChat(title: string): Promise<ExecutionContext> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `pdup-${title}-${TS}`,
  });
  return {
    actorId: HUMAN,
    actorKind: "ai",
    requestId: `pdup-${title}`,
    chatBranchId: v.chatBranchId,
    chatTaskId: v.chatSessionId,
  };
}

/**
 * A holder whose `cta` (module field) shows a card and whose `items`
 * (module-list) shows a card and a nested holder that again shows a card:
 * three levels of nested content.
 */
async function nestedHolder(label: string): Promise<{
  holder: string;
  ctaCard: string;
  itemCard: string;
  innerHolder: string;
  innerCard: string;
}> {
  const ctaCard = await instance(cardId, { title: `${label} cta` });
  const itemCard = await instance(cardId, { title: `${label} item` });
  const innerCard = await instance(cardId, { title: `${label} inner` });
  const innerHolder = await instance(holderId, {
    heading: `${label} inner holder`,
    cta: { moduleId: cardId, contentInstanceId: innerCard },
    items: [],
  });
  const holder = await instance(holderId, {
    heading: `${label} holder`,
    cta: { moduleId: cardId, contentInstanceId: ctaCard },
    items: [
      { moduleId: cardId, contentInstanceId: itemCard },
      { moduleId: holderId, contentInstanceId: innerHolder },
    ],
  });
  return { holder, ctaCard, itemCard, innerHolder, innerCard };
}

/** Every content instance id reachable from `rootId`, values included, depth-first. */
async function tree(
  ctx: ExecutionContext,
  rootId: string,
): Promise<{ id: string; values: Record<string, unknown> }[]> {
  const values = await valuesOf(ctx, rootId);
  const out = [{ id: rootId, values }];
  const refs: Ref[] = [];
  if (values.cta) refs.push(values.cta as Ref);
  if (Array.isArray(values.items)) refs.push(...(values.items as Ref[]));
  for (const ref of refs) out.push(...(await tree(ctx, ref.contentInstanceId)));
  return out;
}

/** Strip nested ids so two trees compare by content alone. */
function shape(values: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(values), (k, v) => (k === "contentInstanceId" ? "<id>" : v));
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `pdup-tpl-${TS}`,
      displayName: "PDUP tpl",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  sectionId = await createModule("section", "<section>{{body}}</section>", [
    { name: "body", kind: "text", label: "Body" },
  ]);
  heroId = await createModule("hero", "<h1>{{headline}}</h1>", [
    { name: "headline", kind: "text", label: "Headline" },
  ]);
  cardId = await createModule("card", "<p>{{title}}</p>", [
    { name: "title", kind: "text", label: "Title" },
  ]);
  holderId = await createModule(
    "holder",
    "<div><h2>{{heading}}</h2>{{>cta}}{{#items}}{{>.}}{{/items}}</div>",
    [
      { name: "heading", kind: "text", label: "Heading" },
      { name: "cta", kind: "module", label: "CTA" },
      { name: "items", kind: "module-list", label: "Items" },
    ],
  );
});

afterAll(async () => {
  await adapter.close();
});

describe("pages.duplicate — repeated module placements", () => {
  it("a module placed four times keeps each placement's content in order", async () => {
    const pageId = await createPage("repeat");
    const layout = [heroId, sectionId, sectionId, sectionId, sectionId];
    await op(SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: layout }],
    });
    const values = [
      { headline: "Hero" },
      { body: "Section one" },
      { body: "Section two" },
      { body: "Section three" },
      { body: "Section four" },
    ];
    for (let i = 0; i < values.length; i += 1) {
      await op(SYS, "page_module_content.set", {
        pageId,
        blockName: "content",
        position: i,
        contentValues: values[i],
      });
    }

    // Several copies: a random pairing would get one of them wrong.
    for (let n = 0; n < 4; n += 1) {
      const copyId = await duplicate(SYS, pageId, `repeat-copy-${n}`);
      const copy = await placementsOf(SYS, copyId);
      expect(copy.map((p) => [p.blockName, p.position, p.values])).toEqual(
        values.map((v, i) => ["content", i, v]),
      );
      const sourceRows = await rowsOf(pageId);
      const copyRows = await rowsOf(copyId);
      expect(copyRows.map((r) => r.module_id)).toEqual(layout);
      expect(copyRows.every((r) => r.sync_mode === "unsynced")).toBe(true);
      // Every placement owns new content.
      const sourceIds = new Set(sourceRows.map((r) => r.ci));
      expect(copyRows.some((r) => sourceIds.has(r.ci))).toBe(false);
      expect(new Set(copyRows.map((r) => r.ci)).size).toBe(copyRows.length);
    }
  });
});

describe("pages.duplicate — nested content", () => {
  it("module and module-list content is deep-copied; editing the copy leaves the source alone", async () => {
    const src = await nestedHolder("Deep");
    const pageId = await createPage("nested");
    await op(SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [holderId] }],
    });
    await op(SYS, "placement.set_content", {
      pageId,
      blockName: "content",
      position: 0,
      contentInstanceId: src.holder,
      syncMode: "unsynced",
    });
    const sourceTree = await tree(SYS, src.holder);
    expect(sourceTree).toHaveLength(5);

    const copyId = await duplicate(SYS, pageId, "nested-copy");
    const copyHolder = (await rowsOf(copyId))[0]?.ci;
    expect(copyHolder).toBeDefined();
    const copyTree = await tree(SYS, copyHolder!);
    // Same content, three levels deep…
    expect(copyTree.map((n) => shape(n.values))).toEqual(sourceTree.map((n) => shape(n.values)));
    // …in rows of its own: no id of the copy is an id of the source.
    const sourceIds = new Set(sourceTree.map((n) => n.id));
    expect(copyTree.some((n) => sourceIds.has(n.id))).toBe(false);

    // Edit every nested level of the copy; the source keeps its text.
    for (const node of copyTree.slice(1)) {
      const isCard = "title" in node.values;
      await op(SYS, "content_instances.set_values", {
        id: node.id,
        values: isCard ? { title: "Übersetzt" } : { ...node.values, heading: "Übersetzt" },
      });
    }
    expect((await tree(SYS, src.holder)).map((n) => n.values)).toEqual(
      sourceTree.map((n) => n.values),
    );
  });
});

describe("pages.duplicate — in a chat", () => {
  it("copies the chat's layout and draft content, nested edits included", async () => {
    const src = await nestedHolder("Draft");
    const pageId = await createPage("chat-src");
    await op(SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [sectionId, sectionId, holderId] }],
    });
    await op(SYS, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: { body: "Main one" },
    });
    await op(SYS, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 1,
      contentValues: { body: "Main two" },
    });
    await op(SYS, "placement.set_content", {
      pageId,
      blockName: "content",
      position: 2,
      contentInstanceId: src.holder,
      syncMode: "unsynced",
    });

    const chat = await draftChat("dup");
    // The chat puts a hero first and rewrites a section and a nested card.
    await op(chat, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [heroId, sectionId, sectionId, holderId] }],
    });
    await op(chat, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: { headline: "Chat hero" },
    });
    await op(chat, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 2,
      contentValues: { body: "Chat two" },
    });
    await op(chat, "content_instances.set_values", {
      id: src.itemCard,
      values: { title: "Chat item" },
    });

    const copyId = await duplicate(chat, pageId, "chat-copy");
    const inChat = await placementsOf(chat, pageId);
    const copy = await placementsOf(chat, copyId);
    expect(copy.map((p) => [p.moduleSlug, shape(p.values as Record<string, unknown>)])).toEqual(
      inChat.map((p) => [p.moduleSlug, shape(p.values as Record<string, unknown>)]),
    );
    expect(copy.map((p) => p.values).slice(0, 3)).toEqual([
      { headline: "Chat hero" },
      { body: "Main one" },
      { body: "Chat two" },
    ]);
    // The nested card carries the chat's draft text, in a row of its own.
    const copyHolder = (await rowsOf(copyId))[3]?.ci;
    const copyTree = await tree(chat, copyHolder!);
    expect(copyTree.map((n) => n.values.title).filter(Boolean)).toEqual([
      "Draft cta",
      "Chat item",
      "Draft inner",
    ]);
    const sourceIds = new Set((await tree(chat, src.holder)).map((n) => n.id));
    expect(copyTree.some((n) => sourceIds.has(n.id))).toBe(false);

    // Main never sees the copy and keeps its own source.
    expect((await run(SYS, "content_instances.get", { id: copyHolder! })).ok).toBe(false);
    expect((await placementsOf(SYS, pageId)).map((p) => p.values)).toEqual([
      { body: "Main one" },
      { body: "Main two" },
      { heading: "Draft holder", cta: expect.anything(), items: expect.anything() },
    ]);
    expect((await valuesOf(SYS, src.itemCard)).title).toBe("Draft item");
  });
});

describe("placement.fork_content — nested content", () => {
  it("the fork owns copies of its nested content", async () => {
    const src = await nestedHolder("Fork");
    const pageId = await createPage("fork");
    await op(SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [holderId] }],
    });
    await op(SYS, "placement.set_content", {
      pageId,
      blockName: "content",
      position: 0,
      contentInstanceId: src.holder,
      syncMode: "synced",
    });
    const forked = await op<{ contentInstanceId: string }>(SYS, "placement.fork_content", {
      pageId,
      blockName: "content",
      position: 0,
    });
    const sourceTree = await tree(SYS, src.holder);
    const forkTree = await tree(SYS, forked.contentInstanceId);
    expect(forkTree.map((n) => shape(n.values))).toEqual(sourceTree.map((n) => shape(n.values)));
    const sourceIds = new Set(sourceTree.map((n) => n.id));
    expect(forkTree.some((n) => sourceIds.has(n.id))).toBe(false);

    const forkCta = (forkTree[0]!.values.cta as Ref).contentInstanceId;
    await op(SYS, "content_instances.set_values", { id: forkCta, values: { title: "Forked" } });
    expect((await valuesOf(SYS, src.ctaCard)).title).toBe("Fork cta");
  });
});

describe("page_module_content.set — nested content of one page", () => {
  async function holderPage(slug: string, ctaCard: string): Promise<string> {
    const pageId = await createPage(slug);
    await op(SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [holderId] }],
    });
    await op(SYS, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: {
        heading: slug,
        cta: { moduleId: cardId, contentInstanceId: ctaCard },
        items: [],
      },
    });
    return pageId;
  }

  it("writes the nested content this page alone renders, and refuses content another page shares", async () => {
    const own = await instance(cardId, { title: "own cta" });
    const ownPage = await holderPage("nested-own", own);
    const nested = (await placementsOf(SYS, ownPage))[0] as unknown as {
      nested: { path: string; contentInstanceId: string; exclusive: boolean }[];
    };
    expect(nested.nested).toEqual([
      expect.objectContaining({ path: "cta", contentInstanceId: own, exclusive: true }),
    ]);
    await op(SYS, "page_module_content.set", {
      pageId: ownPage,
      blockName: "content",
      position: 0,
      nestedPath: "cta",
      contentValues: { title: "own cta, translated" },
    });
    expect(await valuesOf(SYS, own)).toEqual({ title: "own cta, translated" });

    // Two pages whose holders show the same card: writing it from one
    // page would change the other.
    const shared = await instance(cardId, { title: "shared cta" });
    const first = await holderPage("nested-shared-a", shared);
    await holderPage("nested-shared-b", shared);
    const refused = await run(SYS, "page_module_content.set", {
      pageId: first,
      blockName: "content",
      position: 0,
      nestedPath: "cta",
      contentValues: { title: "changed" },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(JSON.stringify(refused.error)).toContain("shared with another page");
      expect(JSON.stringify(refused.error)).toContain("fork_placement_content");
    }
    expect(await valuesOf(SYS, shared)).toEqual({ title: "shared cta" });

    const missing = await run(SYS, "page_module_content.set", {
      pageId: first,
      blockName: "content",
      position: 0,
      nestedPath: "items[3]",
      contentValues: { title: "x" },
    });
    expect(missing.ok).toBe(false);
  });

  it("content_instances.set_values stays closed to plugins: their writes are bound to a page", async () => {
    const card = await instance(cardId, { title: "anywhere" });
    const asPlugin = await run(
      { actorId: HUMAN, actorKind: "plugin", requestId: "pdup-plugin" },
      "content_instances.set_values",
      { id: card, values: { title: "overwritten" } },
    );
    expect(asPlugin.ok).toBe(false);
    expect(await valuesOf(SYS, card)).toEqual({ title: "anywhere" });
  });
});
