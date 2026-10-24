// SPDX-License-Identifier: MPL-2.0

/**
 * Content instances and placements as a chat on the shared draft sees them.
 *
 *   - #1045 — `page_module_content.set` resolves (block, position) through
 *     the chat's branch-overlaid layout: after the chat reshaped the page
 *     (inserted a module, forked a synced placement, removed + rebuilt),
 *     the write hits the chat's placement, never main's row at the same
 *     position. `list_for_page` and `content_instances.list({ pageId })`
 *     read the same view.
 *   - #1067 — `content_instances.get` / `.list` / `.set_values` report
 *     placements as the branch sees them, and count nested parents (a
 *     child shown inside a parent's module-list is not an orphan);
 *     `content_instances.delete` refuses a child that still has a parent.
 *   - #1042 — nested-ref validation reads the owning module's fields as
 *     the chat edited them.
 *   - #1062 — `content_instances.list_module_peers` returns only the
 *     instances of the modules a write touched (module-scoped read).
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { getContentInstanceTool } from "../ai/tools/get-content-instance.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "cibv-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let cardId = "";
let heroId = "";

async function run(ctx: ExecutionContext, name: string, input: unknown) {
  return execute(registry, adapter, ctx, name, input);
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await run(ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A new chat on the site's shared draft, as the AI acting in it. */
async function draftChat(title: string): Promise<ExecutionContext> {
  const v = await op<{ chatSessionId: string; chatBranchId: string; branchKind: string }>(
    SYS,
    "chat.create_session",
    { title: `cibv-${title}-${TS}` },
  );
  expect(v.branchKind).toBe("draft");
  return {
    actorId: HUMAN,
    actorKind: "ai",
    requestId: `cibv-${title}`,
    chatBranchId: v.chatBranchId,
    chatTaskId: v.chatSessionId,
  };
}

async function createModule(
  slug: string,
  html: string,
  fields: Record<string, unknown>[],
): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `cibv-${slug}-${TS}`,
      displayName: `CIBV ${slug}`,
      html,
      fields,
    })
  ).moduleId;
}

/** A live page whose content block holds `moduleIds`, each filled with `titles[i]`. */
async function livePage(slug: string, titles: string[]): Promise<string> {
  const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
    slug: `cibv-${slug}-${TS}`,
    name: slug,
    title: slug,
    templateId,
  });
  await op(SYS, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: titles.map(() => cardId) }],
  });
  for (let i = 0; i < titles.length; i += 1) {
    await op(SYS, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: i,
      contentValues: { title: titles[i] },
    });
  }
  return pageId;
}

type Placement = { blockName: string; position: number; moduleSlug: string; values: unknown };

async function listForPage(ctx: ExecutionContext, pageId: string): Promise<Placement[]> {
  return (
    await op<{ placements: Placement[] }>(ctx, "page_module_content.list_for_page", { pageId })
  ).placements;
}

type Got = {
  instance: { values: Record<string, unknown>; placementCount: number; nestedParentCount: number };
  placements: { pageId: string; position: number; syncMode: string }[];
  nestedParents: string[];
};

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `cibv-tpl-${TS}`,
      displayName: "CIBV tpl",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  cardId = await createModule("card", "<p>{{title}}</p>", [
    { name: "title", kind: "text", label: "Title" },
  ]);
  heroId = await createModule("hero", "<h1>{{headline}}</h1>", [
    { name: "headline", kind: "text", label: "Headline" },
  ]);
});

afterAll(async () => {
  await adapter.close();
});

describe("#1045 — placement writes resolve through the chat's layout", () => {
  it("a module inserted on the draft takes the write at its position; main's row there is untouched", async () => {
    const pageId = await livePage("insert", ["A0", "A1", "A2"]);
    const chat = await draftChat("insert");
    // The chat inserts a hero at position 1: [card, hero, card, card].
    await op(chat, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [cardId, heroId, cardId, cardId] }],
    });
    await op(chat, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 1,
      contentValues: { headline: "Inserted" },
    });

    const inChat = await listForPage(chat, pageId);
    expect(inChat.map((p) => p.values)).toEqual([
      { title: "A0" },
      { headline: "Inserted" },
      { title: "A1" },
      { title: "A2" },
    ]);
    expect(inChat[1]?.moduleSlug).toBe(`cibv-hero-${TS}`);
    // Main still shows its three cards with their own values.
    expect((await listForPage(SYS, pageId)).map((p) => p.values)).toEqual([
      { title: "A0" },
      { title: "A1" },
      { title: "A2" },
    ]);

    // list_content_instances({ pageId }) lists the chat's placements.
    const listed = await op<{ instances: { moduleId: string }[] }>(chat, "content_instances.list", {
      pageId,
    });
    expect(listed.instances.filter((i) => i.moduleId === heroId)).toHaveLength(1);
    const listedMain = await op<{ instances: { moduleId: string }[] }>(
      SYS,
      "content_instances.list",
      { pageId },
    );
    expect(listedMain.instances.filter((i) => i.moduleId === heroId)).toHaveLength(0);
  });

  it("a placement forked on the draft can be set right away (main's placement is still synced)", async () => {
    const shared = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: cardId,
      slug: `cibv-shared-${TS}`,
      displayName: "Shared card",
      purpose: "test",
      values: { title: "Shared" },
    });
    const pageId = await livePage("fork", ["F0"]);
    await op(SYS, "placement.set_content", {
      pageId,
      blockName: "content",
      position: 0,
      contentInstanceId: shared.contentInstanceId,
      syncMode: "synced",
    });
    const chat = await draftChat("fork");
    const forked = await op<{ contentInstanceId: string }>(chat, "placement.fork_content", {
      pageId,
      blockName: "content",
      position: 0,
    });
    await op(chat, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: { title: "Local edit" },
    });
    expect((await listForPage(chat, pageId))[0]?.values).toEqual({ title: "Local edit" });
    const sharedInChat = await op<Got>(chat, "content_instances.get", {
      id: shared.contentInstanceId,
    });
    expect(sharedInChat.instance.values).toEqual({ title: "Shared" });
    // #1067 — the fork rebinds only the chat's layout: in the chat the
    // shared row has no placement any more, on main it still has one.
    expect(sharedInChat.placements).toHaveLength(0);
    expect(sharedInChat.instance.placementCount).toBe(0);
    const sharedOnMain = await op<Got>(SYS, "content_instances.get", {
      id: shared.contentInstanceId,
    });
    expect(sharedOnMain.placements).toHaveLength(1);
    expect(forked.contentInstanceId).not.toBe(shared.contentInstanceId);
  });

  it("after remove + build_page on the draft, the write hits the rebuilt instance", async () => {
    const pageId = await livePage("rebuild", ["Old"]);
    const oldInstance = (
      await op<{ instances: { id: string }[] }>(SYS, "content_instances.list", { pageId })
    ).instances[0]?.id as string;
    const chat = await draftChat("rebuild");
    await op(chat, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [] }],
    });
    await op(chat, "pages.build_page", {
      page: { pageId },
      modules: [
        {
          blockName: "content",
          moduleId: cardId,
          content: { source: "inline", values: { title: "Built" } },
        },
      ],
    });
    await op(chat, "page_module_content.set", {
      pageId,
      blockName: "content",
      position: 0,
      contentValues: { title: "Edited" },
    });
    expect((await listForPage(chat, pageId)).map((p) => p.values)).toEqual([{ title: "Edited" }]);
    const old = await op<Got>(chat, "content_instances.get", { id: oldInstance });
    expect(old.instance.values).toEqual({ title: "Old" });
    expect(old.placements).toHaveLength(0);
  });
});

describe("#1067 — placements and nested parents as the caller sees them", () => {
  it("a placement bound on the draft shows in get / list / set_values there, not on main", async () => {
    const shared = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: cardId,
      slug: `cibv-bound-${TS}`,
      displayName: "Bound on draft",
      purpose: "test",
      values: { title: "Bound" },
    });
    const pageId = await livePage("bind", ["B0"]);
    const chat = await draftChat("bind");
    await op(chat, "placement.set_content", {
      pageId,
      blockName: "content",
      position: 0,
      contentInstanceId: shared.contentInstanceId,
      syncMode: "synced",
    });
    const got = await op<Got>(chat, "content_instances.get", { id: shared.contentInstanceId });
    expect(got.placements).toEqual([
      expect.objectContaining({ pageId, position: 0, syncMode: "synced" }),
    ]);
    expect(got.instance.placementCount).toBe(1);
    const listed = await op<{ instances: { id: string; placementCount: number }[] }>(
      chat,
      "content_instances.list",
      {},
    );
    expect(listed.instances.find((i) => i.id === shared.contentInstanceId)?.placementCount).toBe(1);
    const written = await op<{ placementCount: number }>(chat, "content_instances.set_values", {
      id: shared.contentInstanceId,
      values: { title: "Bound v2" },
    });
    expect(written.placementCount).toBe(1);
    const onMain = await op<Got>(SYS, "content_instances.get", { id: shared.contentInstanceId });
    expect(onMain.placements).toHaveLength(0);
    // ...and the delete refuses in the chat, where the placement exists.
    const del = await run(chat, "content_instances.delete", { id: shared.contentInstanceId });
    expect(del.ok).toBe(false);
  });

  it("a child shown in a parent's module-list is not an orphan; delete refuses until it is removed", async () => {
    const listModule = await createModule("list", "<ul>{{#items}}{{>.}}{{/items}}</ul>", [
      { name: "items", kind: "module-list", label: "Items" },
    ]);
    const child = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: cardId,
      displayName: "Nested child",
      purpose: "test",
      values: { title: "Child" },
    });
    const parent = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: listModule,
      displayName: "Parent list",
      purpose: "test",
      values: { items: [{ moduleId: cardId, contentInstanceId: child.contentInstanceId }] },
    });

    const got = await op<Got>(SYS, "content_instances.get", { id: child.contentInstanceId });
    expect(got.placements).toHaveLength(0);
    expect(got.nestedParents).toEqual([parent.contentInstanceId]);
    expect(got.instance.nestedParentCount).toBe(1);
    const listed = await op<{ instances: { id: string; nestedParentCount: number }[] }>(
      SYS,
      "content_instances.list",
      { moduleId: cardId },
    );
    expect(listed.instances.find((i) => i.id === child.contentInstanceId)?.nestedParentCount).toBe(
      1,
    );

    // The AI tool never calls it an orphan.
    const tool = await getContentInstanceTool.handler(SYS, { id: child.contentInstanceId }, {
      registry,
      adapter,
    } as unknown as Parameters<typeof getContentInstanceTool.handler>[2]);
    expect(tool.content).not.toContain("safe to delete");
    expect(tool.content).toContain(parent.contentInstanceId);

    const refused = await run(SYS, "content_instances.delete", { id: child.contentInstanceId });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const message = "message" in refused.error ? refused.error.message : "";
    expect(message).toContain(parent.contentInstanceId);
    expect(message).toContain("set_content_instance_values");

    // In a chat, removing the child from the parent's list frees it there.
    const chat = await draftChat("nested");
    await op(chat, "content_instances.set_values", {
      id: parent.contentInstanceId,
      values: { items: [] },
    });
    const inChat = await op<Got>(chat, "content_instances.get", { id: child.contentInstanceId });
    expect(inChat.nestedParents).toEqual([]);
    expect((await run(chat, "content_instances.delete", { id: child.contentInstanceId })).ok).toBe(
      true,
    );
    // Main still has the parent showing the child.
    expect(
      (await op<Got>(SYS, "content_instances.get", { id: child.contentInstanceId })).nestedParents,
    ).toEqual([parent.contentInstanceId]);
  });
});

describe("#1042 — nested-ref validation reads the chat's module schema", () => {
  it("a field the chat turned from module into module-list accepts a list", async () => {
    const holder = await createModule("holder", "<div>{{>cta}}</div>", [
      { name: "cta", kind: "module", label: "CTA" },
    ]);
    const card = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: cardId,
      displayName: "CTA card",
      purpose: "test",
      values: { title: "CTA" },
    });
    const instance = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: holder,
      displayName: "Holder",
      purpose: "test",
      values: { cta: { moduleId: cardId, contentInstanceId: card.contentInstanceId } },
    });
    const chat = await draftChat("schema");
    await op(chat, "modules.update", {
      moduleId: holder,
      html: "<div>{{#cta}}{{>.}}{{/cta}}</div>",
      fields: [{ name: "cta", kind: "module-list", label: "CTAs" }],
    });
    await op(chat, "content_instances.set_values", {
      id: instance.contentInstanceId,
      values: { cta: [] },
    });
    const got = await op<Got>(chat, "content_instances.get", { id: instance.contentInstanceId });
    expect(got.instance.values).toEqual({ cta: [] });
    // Main's schema still says `module`: the same write without the chat fails there.
    expect(
      (
        await run(SYS, "content_instances.set_values", {
          id: instance.contentInstanceId,
          values: { cta: [] },
        })
      ).ok,
    ).toBe(false);
  });
});

describe("#1062 — list_module_peers reads only the touched modules", () => {
  it("resolves module ids, instance ids and the chat's placements; other modules are absent", async () => {
    const pageId = await livePage("peers", ["P0"]);
    const chat = await draftChat("peers");
    // On the chat, position 0 becomes a hero: the placement resolves to hero.
    await op(chat, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [heroId] }],
    });
    type Peers = { instances: { moduleId: string; placementCount: number }[] };
    const byPlacement = await op<Peers>(chat, "content_instances.list_module_peers", {
      placements: [{ pageId, blockName: "content", position: 0 }],
    });
    expect(byPlacement.instances.length).toBeGreaterThan(0);
    expect(new Set(byPlacement.instances.map((i) => i.moduleId))).toEqual(new Set([heroId]));
    const onMain = await op<Peers>(SYS, "content_instances.list_module_peers", {
      placements: [{ pageId, blockName: "content", position: 0 }],
    });
    expect(new Set(onMain.instances.map((i) => i.moduleId))).toEqual(new Set([cardId]));

    const cardInstance = (
      await op<{ instances: { id: string }[] }>(SYS, "content_instances.list", { pageId })
    ).instances[0]?.id as string;
    const byInstance = await op<Peers>(SYS, "content_instances.list_module_peers", {
      contentInstanceIds: [cardInstance],
    });
    expect(byInstance.instances.every((i) => i.moduleId === cardId)).toBe(true);
    const byModule = await op<Peers>(SYS, "content_instances.list_module_peers", {
      moduleIds: [heroId],
    });
    expect(byModule.instances.every((i) => i.moduleId === heroId)).toBe(true);
    expect((await op<Peers>(SYS, "content_instances.list_module_peers", {})).instances).toEqual([]);
  });
});
