// SPDX-License-Identifier: MPL-2.0

/**
 * #627 — a content instance referenced only from inside a parent is not an
 * orphan, and its blast radius is every page the parent renders on.
 *
 *   - A grandchild (parent → child → grandchild, only the root placed on
 *     two pages) reports both pages in `content_instances.get` / `.list`
 *     and `set_values`; its value edit emits `page.updated` for both.
 *   - A child shown only by a module's field default in layout chrome is
 *     refused on delete and reported as site-wide.
 *   - Deleting a nested-only child is refused with the parent and the
 *     pages named; `delete_many` with the unplaced parent first succeeds.
 *   - Reach through a module default follows a chat's branch page layouts:
 *     a placement the chat adds counts, one it removes does not.
 *   - An embedded instance that leaves a field unset renders its module's
 *     default there (a local list also when it stores null), so the
 *     default's child reaches the embedding pages.
 *   - `snapshots.publish_impact_pages` and `chat.branch_edited_entities`
 *     carry content-instance edits to the pages they render on.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { getContentInstanceTool } from "../ai/tools/get-content-instance.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "cireach-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let layoutId = "";
let templateId = "";
let cardId = "";
let listModuleId = "";

async function run(ctx: ExecutionContext, name: string, input: unknown) {
  return execute(registry, adapter, ctx, name, input);
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await run(ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function createModule(
  slug: string,
  html: string,
  fields: Record<string, unknown>[],
): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `cireach-${slug}-${TS}`,
      displayName: `CIREACH ${slug}`,
      html,
      fields,
    })
  ).moduleId;
}

async function instance(moduleId: string, name: string, values: unknown): Promise<string> {
  return (
    await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId,
      displayName: name,
      purpose: "test",
      values,
    })
  ).contentInstanceId;
}

/** A live page whose content block holds one `listModuleId` placement bound to `rootId`. */
async function pageShowing(slug: string, rootId: string): Promise<string> {
  const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
    slug: `cireach-${slug}-${TS}`,
    shortTitle: slug,
    title: slug,
    templateId,
  });
  await op(SYS, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [listModuleId] }],
  });
  await op(SYS, "placement.set_content", {
    pageId,
    blockName: "content",
    position: 0,
    contentInstanceId: rootId,
    syncMode: "synced",
  });
  return pageId;
}

const ref = (contentInstanceId: string, moduleId = cardId) => ({ moduleId, contentInstanceId });

type Got = {
  instance: {
    placementCount: number;
    parentCount: number;
    renderedPageCount: number;
    rendersSiteWide: boolean;
  };
  nestedParents: string[];
  parentModules: { moduleId: string; field: string }[];
  renderedOn: { pageId: string; path: string }[];
  chromeLayouts: { layoutId: string }[];
};

async function setFieldDefault(moduleId: string, field: string, value: unknown): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`SELECT fields FROM modules WHERE id = ${moduleId}::uuid`) as {
        fields: { name: string }[];
      }[];
      const fields = (rows[0]?.fields ?? []).map((f) =>
        f.name === field ? { ...f, default: value } : f,
      );
      await tx`UPDATE modules SET fields = (${JSON.stringify(fields)}::text)::jsonb WHERE id = ${moduleId}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

async function pageUpdatedEventsFor(contentInstanceId: string): Promise<string[]> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`
        SELECT entity_id::text AS page_id FROM domain_events
         WHERE kind = 'page.updated' AND payload->>'contentInstanceId' = ${contentInstanceId}
      `;
    })) as unknown as { page_id: string }[];
    return rows.map((r) => r.page_id).sort();
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  layoutId = (
    await op<{ layoutId: string }>(SYS, "layouts.create", {
      slug: `cireach-layout-${TS}`,
      displayName: "CIREACH layout",
      html: `<!doctype html><html><head><title>L</title></head><body><caelo-slot name="header">_</caelo-slot><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
      blocks: [
        { name: "header", displayName: "Header", position: 0 },
        { name: "content", displayName: "Content", position: 1 },
      ],
    })
  ).layoutId;
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `cireach-tpl-${TS}`,
      displayName: "CIREACH tpl",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      css: "",
      layoutId,
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  cardId = await createModule("card", "<p>{{title}}</p>", [
    { name: "title", kind: "text", label: "Title" },
  ]);
  listModuleId = await createModule("list", "<ul>{{#items}}{{>.}}{{/items}}</ul>", [
    { name: "items", kind: "module-list", label: "Items" },
  ]);
});

afterAll(async () => {
  await adapter.close();
});

describe("#627 — nested-only instances reach the pages their parents render on", () => {
  it("a grandchild reports, and on edit marks, every page of its root", async () => {
    const grandchild = await instance(cardId, "Grandchild", { title: "Deep" });
    const middle = await instance(listModuleId, "Middle", {
      items: [ref(grandchild, cardId)],
    });
    const root = await instance(listModuleId, "Root", { items: [ref(middle, listModuleId)] });
    const pageA = await pageShowing("a", root);
    const pageB = await pageShowing("b", root);

    const got = await op<Got>(SYS, "content_instances.get", { id: grandchild });
    expect(got.instance.placementCount).toBe(0);
    expect(got.nestedParents).toEqual([middle]);
    expect(got.instance.parentCount).toBe(1);
    expect(got.renderedOn.map((p) => p.pageId).sort()).toEqual([pageA, pageB].sort());
    expect(got.instance.renderedPageCount).toBe(2);

    const listed = await op<{
      instances: { id: string; renderedPageCount: number; parentCount: number }[];
    }>(SYS, "content_instances.list", { moduleId: cardId });
    const row = listed.instances.find((i) => i.id === grandchild);
    expect(row?.renderedPageCount).toBe(2);
    expect(row?.parentCount).toBe(1);

    const tool = await getContentInstanceTool.handler(SYS, { id: grandchild }, {
      registry,
      adapter,
    } as unknown as Parameters<typeof getContentInstanceTool.handler>[2]);
    expect(tool.content).not.toContain("safe to delete");
    expect(tool.content).toContain("renders on 2 page(s)");

    const written = await op<{ renderedPageCount: number; placementCount: number }>(
      SYS,
      "content_instances.set_values",
      { id: grandchild, values: { title: "Deeper" } },
    );
    expect(written.placementCount).toBe(0);
    expect(written.renderedPageCount).toBe(2);
    // Staleness workers see the edit on both pages, not on none.
    expect(await pageUpdatedEventsFor(grandchild)).toEqual([pageA, pageB].sort());

    // A Publish live re-bakes the ancestor pages of a nested-only edit.
    const impact = await op<{ pageIds: string[]; fullSite: boolean }>(
      SYS,
      "snapshots.publish_impact_pages",
      { contentInstanceIds: [grandchild] },
    );
    expect(impact.fullSite).toBe(false);
    expect(impact.pageIds.sort()).toEqual([pageA, pageB].sort());
  });

  it("deleting a nested-only child is refused with its parent and pages named", async () => {
    const child = await instance(cardId, "Refused child", { title: "Kept" });
    const parent = await instance(listModuleId, "Placed parent", { items: [ref(child)] });
    await pageShowing("refuse", parent);

    const refused = await run(SYS, "content_instances.delete", { id: child });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const message = (refused.error as { message: string }).message;
    expect(message).toContain(parent);
    expect(message).toContain(`/cireach-refuse-${TS}`);
    expect(message).toContain("set_content_instance_values_many");

    const still = await op<Got>(SYS, "content_instances.get", { id: child });
    expect(still.instance.renderedPageCount).toBe(1);
  });

  it("delete_many removes an unplaced parent and its child when the parent comes first", async () => {
    const child = await instance(cardId, "Batch child", { title: "Gone" });
    const parent = await instance(listModuleId, "Unplaced parent", { items: [ref(child)] });

    // Child first: its parent still shows it, so the whole batch rolls back.
    const wrongOrder = await run(SYS, "content_instances.delete_many", {
      items: [{ id: child }, { id: parent }],
    });
    expect(wrongOrder.ok).toBe(false);
    const parentAfter = await op<{ instance: { deletedAt: string | null } }>(
      SYS,
      "content_instances.get",
      { id: parent },
    );
    expect(parentAfter.instance.deletedAt).toBeNull();

    await op(SYS, "content_instances.delete_many", { items: [{ id: parent }, { id: child }] });
  });

  it("a child shown only by a chrome module's field default is site-wide and not deletable", async () => {
    const child = await instance(cardId, "Chrome child", { title: "Header item" });
    const chrome = await createModule("chrome", "<header>{{#items}}{{>.}}{{/items}}</header>", [
      { name: "items", kind: "module-list", label: "Items" },
    ]);
    // A field default holding nested refs is the shape layout chrome carries
    // (the renderer reads defaults since #626); the module ops do not author
    // module-list defaults, so it is written to the row directly.
    await setFieldDefault(chrome, "items", [ref(child)]);
    await op(SYS, "layout_modules.set", { layoutId, blockName: "header", moduleIds: [chrome] });
    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `cireach-chrome-page-${TS}`,
      shortTitle: "chrome",
      title: "chrome",
      templateId,
    });

    const got = await op<Got>(SYS, "content_instances.get", { id: child });
    expect(got.instance.placementCount).toBe(0);
    expect(got.parentModules).toEqual([
      expect.objectContaining({ moduleId: chrome, field: "items" }),
    ]);
    expect(got.chromeLayouts.map((l) => l.layoutId)).toEqual([layoutId]);
    expect(got.instance.rendersSiteWide).toBe(true);

    const refused = await run(SYS, "content_instances.delete", { id: child });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect((refused.error as { message: string }).message).toContain("update_modules_many");
    }

    // The layout's pages are what a Publish live of this edit re-bakes.
    const impact = await op<{ pageIds: string[] }>(SYS, "snapshots.publish_impact_pages", {
      contentInstanceIds: [child],
    });
    expect(impact.pageIds).toContain(pageId);
  });

  it("chrome a chat adds on its branch gives the child site-wide reach there, not on main", async () => {
    const child = await instance(cardId, "Branch chrome child", { title: "Footer item" });
    const footer = await createModule("footer", "<footer>{{#items}}{{>.}}{{/items}}</footer>", [
      { name: "items", kind: "module-list", label: "Items" },
    ]);
    await setFieldDefault(footer, "items", [ref(child)]);
    const session = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `cireach-branch-chrome-${TS}` },
    );
    const chat: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: "cireach-branch-chrome",
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    // The chat places the footer in the layout chrome: a branch snapshot,
    // no live layout_modules row.
    await op(chat, "layout_modules.set", { layoutId, blockName: "header", moduleIds: [footer] });

    const inChat = await op<Got>(chat, "content_instances.get", { id: child });
    expect(inChat.chromeLayouts.map((l) => l.layoutId)).toEqual([layoutId]);
    const onMain = await op<Got>(SYS, "content_instances.get", { id: child });
    expect(onMain.chromeLayouts).toEqual([]);
  });

  it("a chat's page layout adds and removes the reach a module default gives", async () => {
    const child = await instance(cardId, "Default child", { title: "Defaulted" });
    const teaser = await createModule("teaser", "<aside>{{#items}}{{>.}}{{/items}}</aside>", [
      { name: "items", kind: "module-list", label: "Items" },
    ]);
    await setFieldDefault(teaser, "items", [ref(child)]);
    const blankPage = async (slug: string): Promise<string> =>
      (
        await op<{ pageId: string }>(SYS, "pages.create", {
          slug: `cireach-${slug}-${TS}`,
          shortTitle: slug,
          title: slug,
          templateId,
        })
      ).pageId;
    const kept = await blankPage("default-kept");
    const removed = await blankPage("default-removed");
    const added = await blankPage("default-added");
    for (const pageId of [kept, removed]) {
      await op(SYS, "pages.set_modules", {
        pageId,
        blocks: [{ blockName: "content", moduleIds: [teaser] }],
      });
    }
    const session = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `cireach-default-layout-${TS}` },
    );
    const chat: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: "cireach-default-layout",
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    // Branch page layouts only: page_layout_snapshots, no live page_modules change.
    await op(chat, "pages.set_modules", {
      pageId: added,
      blocks: [{ blockName: "content", moduleIds: [teaser] }],
    });
    await op(chat, "pages.set_modules", {
      pageId: removed,
      blocks: [{ blockName: "content", moduleIds: [] }],
    });

    const inChat = await op<Got>(chat, "content_instances.get", { id: child });
    expect(inChat.renderedOn.map((p) => p.pageId).sort()).toEqual([kept, added].sort());
    const onMain = await op<Got>(SYS, "content_instances.get", { id: child });
    expect(onMain.renderedOn.map((p) => p.pageId).sort()).toEqual([kept, removed].sort());

    const written = await op<{ renderedPageCount: number }>(chat, "content_instances.set_values", {
      id: child,
      values: { title: "Edited in chat" },
    });
    expect(written.renderedPageCount).toBe(2);
    expect(await pageUpdatedEventsFor(child)).toEqual([kept, added].sort());
  });

  it("an embedded instance that leaves a field unset shows its module's default there", async () => {
    // page → A (placed) → B (embedded in A) → C (only in B's module default).
    const holder = await createModule("holder", "<div>{{#items}}{{>.}}{{/items}}</div>", [
      { name: "items", kind: "module-list", label: "Items" },
    ]);
    const viaDefault = await instance(cardId, "Default-only grandchild", { title: "Shown" });
    await setFieldDefault(holder, "items", [ref(viaDefault)]);
    const usesDefault = await instance(holder, "Holder without items", {});
    const root = await instance(listModuleId, "Embedding root", {
      items: [ref(usesDefault, holder)],
    });
    const pageId = await pageShowing("embedded-default", root);

    const got = await op<Got>(SYS, "content_instances.get", { id: viaDefault });
    expect(got.instance.placementCount).toBe(0);
    expect(got.renderedOn.map((p) => p.pageId)).toEqual([pageId]);
    await op(SYS, "content_instances.set_values", {
      id: viaDefault,
      values: { title: "Shown, edited" },
    });
    expect(await pageUpdatedEventsFor(viaDefault)).toEqual([pageId]);

    // The same chain where B sets the field: the default does not render.
    const overrider = await createModule("overrider", "<div>{{#items}}{{>.}}{{/items}}</div>", [
      { name: "items", kind: "module-list", label: "Items" },
    ]);
    const hidden = await instance(cardId, "Overridden grandchild", { title: "Hidden" });
    await setFieldDefault(overrider, "items", [ref(hidden)]);
    const overrides = await instance(overrider, "Holder with items", { items: [] });
    const otherRoot = await instance(listModuleId, "Overriding root", {
      items: [ref(overrides, overrider)],
    });
    await pageShowing("embedded-override", otherRoot);

    const notShown = await op<Got>(SYS, "content_instances.get", { id: hidden });
    expect(notShown.renderedOn).toEqual([]);
  });

  it("an embedded instance that stores null for a local list shows the list's default", async () => {
    const typeSlug = `cireach-slots-${TS}`;
    await op(SYS, "list_types.upsert_many", {
      listTypes: [
        {
          slug: typeSlug,
          name: "Slots",
          purpose: "test",
          role: "content",
          root: { allow: ["slot"] },
          nodes: {
            slot: { label: "Slot", fields: [{ name: "block", label: "Block", type: "module" }] },
          },
        },
      ],
    });
    const slots = await createModule("slots", "<div>{{#items}}{{block}}{{/items}}</div>", [
      { name: "items", kind: "list", label: "Items", listType: typeSlug },
    ]);
    const shown = await instance(cardId, "List-default grandchild", { title: "Listed" });
    await setFieldDefault(slots, "items", [
      { id: crypto.randomUUID(), node: "slot", values: { block: ref(shown) } },
    ]);
    const nullHolder = await instance(slots, "Slots stored null", { items: null });
    const emptyHolder = await instance(slots, "Slots stored empty", { items: [] });
    const nullPage = await pageShowing(
      "list-null",
      await instance(listModuleId, "Null root", { items: [ref(nullHolder, slots)] }),
    );
    await pageShowing(
      "list-empty",
      await instance(listModuleId, "Empty root", { items: [ref(emptyHolder, slots)] }),
    );

    // null falls back to the default (resolveListField); [] overrides it.
    const got = await op<Got>(SYS, "content_instances.get", { id: shown });
    expect(got.renderedOn.map((p) => p.pageId)).toEqual([nullPage]);
  });

  it("chat.branch_edited_entities lists the content instances a chat edited", async () => {
    const child = await instance(cardId, "Chat child", { title: "Before" });
    const parent = await instance(listModuleId, "Chat parent", { items: [ref(child)] });
    const pageId = await pageShowing("chat", parent);
    const session = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `cireach-chat-${TS}` },
    );
    const chat: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: "cireach-chat",
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    await op(chat, "content_instances.set_values", { id: child, values: { title: "After" } });

    const edited = await op<{ contentInstanceIds: string[] }>(SYS, "chat.branch_edited_entities", {
      chatSessionId: session.chatSessionId,
    });
    expect(edited.contentInstanceIds).toEqual([child]);
    const impact = await op<{ pageIds: string[] }>(SYS, "snapshots.publish_impact_pages", {
      contentInstanceIds: edited.contentInstanceIds,
    });
    expect(impact.pageIds).toEqual([pageId]);
  });
});
