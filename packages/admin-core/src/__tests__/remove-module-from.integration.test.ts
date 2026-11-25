// SPDX-License-Identifier: MPL-2.0

/**
 * `remove_module_from` — the ONE module-removal tool routed by `target`
 * (page | layout), folding the former remove_module_from_page /
 * remove_module_from_layout. Real Postgres (§6). Covers both targets, slug +
 * uuid targetRef resolution, the "not attached" failure, and the invariant
 * that removal does NOT delete the module row.
 *
 * #1663 — a module placed more than once loses only the addressed
 * placement, the others keep THEIR content (live and on a chat branch), an
 * unaddressed call is refused with the placements and their content listed,
 * and removing every placement takes an explicit `allPlacements: true`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, removeModuleFromToolInput } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { moveModuleTool } from "../ai/tools/move-module.js";
import { removeModuleFromTool } from "../ai/tools/remove-module-from.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "rmmod-int",
};

const PFX = "rmmod";
let templateId: string;
let layoutId: string;
let layoutSlug: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function makeModule(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "modules.create", {
    slug,
    displayName: `M ${slug}`,
    html: "<div>{{body}}</div>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  if (!r.ok) throw new Error(`module ${slug}`);
  return (r.value as { moduleId: string }).moduleId;
}

async function makePage(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug,
    title: slug,
    templateId,
  });
  if (!r.ok) throw new Error(`page ${slug}`);
  return (r.value as { pageId: string }).pageId;
}

async function pageContentModuleIds(pageId: string): Promise<string[]> {
  const r = await execute(registry, adapter, SYSTEM, "pages.get_with_modules", { pageId });
  if (!r.ok) throw new Error("get_with_modules");
  const page = r.value as {
    page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] };
  };
  return (
    page.page.blocks.find((b) => b.blockName === "content")?.modules.map((m) => m.moduleId) ?? []
  );
}

async function moduleExists(moduleId: string): Promise<boolean> {
  const r = await execute(registry, adapter, SYSTEM, "modules.get", { moduleId });
  return r.ok;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
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

  layoutSlug = `${PFX}-layout`;
  const lay = await execute(registry, adapter, SYSTEM, "layouts.create", {
    slug: layoutSlug,
    displayName: "L",
    html: `<!doctype html><html><head><title>L</title></head><body><header><caelo-slot name="header">_</caelo-slot></header><caelo-slot name="content">_</caelo-slot><footer><caelo-slot name="footer">_</caelo-slot></footer></body></html>`,
    css: "",
    blocks: [
      { name: "header", displayName: "Header", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
      { name: "footer", displayName: "Footer", position: 2 },
    ],
  });
  if (!lay.ok) throw new Error("layout seed");
  layoutId = (lay.value as { layoutId: string }).layoutId;

  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
    layoutId,
  });
  if (!tpl.ok) throw new Error("tpl seed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** The `content` block as `module:body` labels, so content travels visibly. */
async function contentLabels(ctx: ExecutionContext, pageId: string): Promise<string[]> {
  const got = await op<{
    page: {
      blocks: {
        blockName: string;
        modules: { slug: string; contentInstanceId: string | null }[];
      }[];
    };
  }>(ctx, "pages.get_with_modules", { pageId });
  const out: string[] = [];
  for (const m of got.page.blocks.find((b) => b.blockName === "content")?.modules ?? []) {
    const ci = await op<{ instance: { values: { body?: string } } }>(ctx, "content_instances.get", {
      id: m.contentInstanceId,
    });
    out.push(`${m.slug.split("-").at(-1)}:${ci.instance.values.body ?? ""}`);
  }
  return out;
}

/**
 * content: [cta "Book a call", text "intro", cta "Call us now", text "outro"]
 * — the #1663 page: one module (cta) placed twice with different content.
 */
async function seedRepeatedPage(ctx: ExecutionContext, name: string) {
  const cta = await makeModule(`${PFX}-${name}-cta`);
  const text = await makeModule(`${PFX}-${name}-text`);
  const { pageId } = await op<{ pageId: string }>(ctx, "pages.create", {
    slug: `${PFX}-${name}`,
    title: name,
    templateId,
  });
  await op(ctx, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [cta, text, cta, text] }],
  });
  const got = await op<{
    page: { blocks: { blockName: string; modules: { contentInstanceId: string }[] }[] };
  }>(ctx, "pages.get_with_modules", { pageId });
  const bodies = ["Book a call", "intro", "Call us now", "outro"];
  const placed = got.page.blocks.find((b) => b.blockName === "content")?.modules ?? [];
  for (const [i, m] of placed.entries()) {
    await op(ctx, "content_instances.set_values", {
      id: m.contentInstanceId,
      values: { body: bodies[i] },
    });
  }
  return { pageId, cta, text };
}

async function chatCtx(title: string): Promise<ExecutionContext> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(
    SYSTEM,
    "chat.create_session",
    { title: `${PFX}-${title}` },
  );
  return {
    actorId: SYSTEM.actorId,
    actorKind: "ai",
    requestId: `${PFX}-${title}`,
    chatBranchId: v.chatBranchId,
    chatTaskId: v.chatSessionId,
  };
}

async function remove(ctx: ExecutionContext, input: Record<string, unknown>) {
  return removeModuleFromTool.handler(ctx, removeModuleFromToolInput.parse(input), toolCtx());
}

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("move_module — same-block move reorders in place (detected-bug)", () => {
  it("moving a module to its CURRENT block repositions it instead of erroring", async () => {
    const a = await makeModule(`${PFX}-mv-a`);
    const b = await makeModule(`${PFX}-mv-b`);
    const pageId = await makePage(`${PFX}-mv-page`);
    await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [a, b] }],
    });
    // order is [a, b]; move `a` to the bottom of the SAME "content" block.
    // Previously this dead-ended with "already in block … use reorder_module" (a tool since retired into move_module);
    // now it performs the reorder in place (§11 — no forced round-trip).
    const res = await moveModuleTool.handler(
      SYSTEM,
      { pageId, moduleId: a, toBlockName: "content", position: "bottom" } as never,
      toolCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("reordered");
    expect(await pageContentModuleIds(pageId)).toEqual([b, a]);
  });
});

describe("remove_module_from — target='page'", () => {
  it("removes the page reference (by page slug) but keeps the module row", async () => {
    const modId = await makeModule(`${PFX}-pmod`);
    const pageId = await makePage(`${PFX}-page`);
    await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [modId] }],
    });
    expect(await pageContentModuleIds(pageId)).toContain(modId);

    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "page", targetRef: `${PFX}-page`, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await pageContentModuleIds(pageId)).not.toContain(modId);
    // The module row survives — removal is detach, not delete.
    expect(await moduleExists(modId)).toBe(true);
  });

  it("also resolves the page by uuid", async () => {
    const modId = await makeModule(`${PFX}-pmod2`);
    const pageId = await makePage(`${PFX}-page2`);
    await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [modId] }],
    });
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "page", targetRef: pageId, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await pageContentModuleIds(pageId)).not.toContain(modId);
  });

  it("fails when the module isn't on the page", async () => {
    const pageId = await makePage(`${PFX}-page3`);
    const other = await makeModule(`${PFX}-notthere`);
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "page", targetRef: pageId, moduleId: other },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
  });
});

describe("#1663 — remove_module_from removes one placement of a repeated module", () => {
  for (const mode of ["live", "chat branch"] as const) {
    it(`removes the addressed placement; the other keeps its own content (${mode})`, async () => {
      const ctx = mode === "live" ? SYSTEM : await chatCtx("one");
      const { pageId, cta } = await seedRepeatedPage(ctx, `one-${mode.replace(" ", "")}`);
      expect(await contentLabels(ctx, pageId)).toEqual([
        "cta:Book a call",
        "text:intro",
        "cta:Call us now",
        "text:outro",
      ]);

      // The FIRST placement goes: set_modules' FIFO alone would have handed
      // its content ("Book a call") to the placement that stays.
      const r = await remove(ctx, {
        target: "page",
        targetRef: pageId,
        moduleId: cta,
        blockName: "content",
        position: 0,
      });
      expect(r.ok).toBe(true);
      expect(r.content).toContain('block "content" position 0');
      expect(r.content).toContain('now at block "content" position 1');
      expect(await contentLabels(ctx, pageId)).toEqual([
        "text:intro",
        "cta:Call us now",
        "text:outro",
      ]);
    });
  }

  it("refuses an unaddressed call, listing each placement with its content", async () => {
    const { pageId, cta } = await seedRepeatedPage(SYSTEM, "ambiguous");
    const r = await remove(SYSTEM, { target: "page", targetRef: pageId, moduleId: cta });
    expect(r.ok).toBe(false);
    expect(r.refusal).toBe(true);
    expect(r.content).toContain("placed 2 times");
    expect(r.content).toContain('block "content" position 0');
    expect(r.content).toContain('body="Book a call"');
    expect(r.content).toContain('block "content" position 2');
    expect(r.content).toContain('body="Call us now"');
    expect(r.content).toContain("blockName + position");
    expect(await contentLabels(SYSTEM, pageId)).toEqual([
      "cta:Book a call",
      "text:intro",
      "cta:Call us now",
      "text:outro",
    ]);
  });

  it("refuses an address the module is not at, naming the real placements", async () => {
    const { pageId, cta } = await seedRepeatedPage(SYSTEM, "wrongpos");
    const r = await remove(SYSTEM, {
      target: "page",
      targetRef: pageId,
      moduleId: cta,
      blockName: "content",
      position: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain('no placement at block "content" position 1');
    expect(r.content).toContain('block "content" position 2');
    expect(await contentLabels(SYSTEM, pageId)).toHaveLength(4);
  });

  it("removes every placement with allPlacements; the other modules keep their content", async () => {
    const { pageId, cta } = await seedRepeatedPage(SYSTEM, "all");
    const r = await remove(SYSTEM, {
      target: "page",
      targetRef: pageId,
      moduleId: cta,
      allPlacements: true,
    });
    expect(r.ok).toBe(true);
    expect(await contentLabels(SYSTEM, pageId)).toEqual(["text:intro", "text:outro"]);
    expect(await moduleExists(cta)).toBe(true);
  });
});

describe("#1663 — one content instance shared across blocks with different sync modes", () => {
  type Bound = { moduleId: string; contentInstanceId: string; syncMode: string };
  type Block = "header" | "content";
  const other = (b: Block): Block => (b === "header" ? "content" : "header");

  /**
   * header: [cta], content: [cta], both bound to ONE instance: unsynced in
   * one block, synced in `syncedIn`. Both directions are tested because the
   * op reads prior placements in block-name order live and in the stored
   * order on a branch, so page order alone was right for one of them.
   */
  async function seedShared(ctx: ExecutionContext, name: string, syncedIn: Block) {
    const { templateId: tpl } = await op<{ templateId: string }>(SYSTEM, "templates.create", {
      pageType: "home",
      slug: `${PFX}-${name}-tpl`,
      displayName: "T2",
      html: '<body><caelo-slot name="header">_</caelo-slot><caelo-slot name="content">_</caelo-slot></body>',
      layoutId,
    });
    await op(SYSTEM, "template_blocks.set", {
      templateId: tpl,
      blocks: [
        { name: "header", displayName: "Header", position: 0 },
        { name: "content", displayName: "Content", position: 1 },
      ],
    });
    const cta = await makeModule(`${PFX}-${name}-cta`);
    const { pageId } = await op<{ pageId: string }>(ctx, "pages.create", {
      slug: `${PFX}-${name}`,
      title: name,
      templateId: tpl,
    });
    await op(ctx, "pages.set_modules", {
      pageId,
      blocks: [
        { blockName: "header", moduleIds: [cta] },
        { blockName: "content", moduleIds: [cta] },
      ],
    });
    const shared = (await placed(ctx, pageId))[other(syncedIn)]?.[0]?.contentInstanceId as string;
    await op(ctx, "placement.set_content", {
      pageId,
      blockName: syncedIn,
      position: 0,
      contentInstanceId: shared,
      syncMode: "synced",
    });
    return { pageId, cta, shared };
  }

  async function placed(ctx: ExecutionContext, pageId: string): Promise<Record<string, Bound[]>> {
    const got = await op<{ page: { blocks: { blockName: string; modules: Bound[] }[] } }>(
      ctx,
      "pages.get_with_modules",
      { pageId },
    );
    return Object.fromEntries(got.page.blocks.map((b) => [b.blockName, b.modules]));
  }

  for (const mode of ["live", "chat branch"] as const) {
    for (const syncedIn of ["header", "content"] as const) {
      it(`removing the unsynced placement leaves the ${syncedIn} one synced (${mode})`, async () => {
        const ctx = mode === "live" ? SYSTEM : await chatCtx(`sync-${syncedIn}`);
        const { pageId, cta, shared } = await seedShared(
          ctx,
          `sync-${syncedIn}-${mode.replace(" ", "")}`,
          syncedIn,
        );
        const before = await placed(ctx, pageId);
        expect(before[other(syncedIn)]?.[0]).toMatchObject({
          contentInstanceId: shared,
          syncMode: "unsynced",
        });
        expect(before[syncedIn]?.[0]).toMatchObject({
          contentInstanceId: shared,
          syncMode: "synced",
        });

        const r = await remove(ctx, {
          target: "page",
          targetRef: pageId,
          moduleId: cta,
          blockName: other(syncedIn),
          position: 0,
        });
        expect(r.ok).toBe(true);
        const after = await placed(ctx, pageId);
        expect(after[other(syncedIn)]).toEqual([]);
        expect(after[syncedIn]?.[0]).toMatchObject({
          contentInstanceId: shared,
          syncMode: "synced",
        });
      });
    }
  }

  it("pages.set_modules refuses a sync mode the instance does not have there", async () => {
    const { pageId, cta, shared } = await seedShared(SYSTEM, "sharedrefuse", "content");
    const r = await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [
        {
          blockName: "header",
          moduleIds: [cta],
          contentInstanceIds: [shared],
          syncModes: ["synced"],
        },
        {
          blockName: "content",
          moduleIds: [cta],
          contentInstanceIds: [shared],
          syncModes: ["synced"],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { message?: string }).message).toContain('named with sync mode "synced"');
    expect((await placed(SYSTEM, pageId)).header?.[0]?.syncMode).toBe("unsynced");
  });

  // Without a stated mode the op used to hand the shared id's modes out in
  // the order it read them, which is not the caller's order: a guess.
  it("pages.set_modules refuses to guess the mode of an id bound both ways", async () => {
    const { pageId, cta, shared } = await seedShared(SYSTEM, "sharedguess", "content");
    for (const blocks of [
      // The survivor of a header removal, named by id alone.
      [
        { blockName: "header", moduleIds: [], contentInstanceIds: [] },
        { blockName: "content", moduleIds: [cta], contentInstanceIds: [shared] },
      ],
      // Both placements named by id alone: still ambiguous.
      [
        { blockName: "header", moduleIds: [cta], contentInstanceIds: [shared] },
        { blockName: "content", moduleIds: [cta], contentInstanceIds: [shared] },
      ],
    ]) {
      const r = await execute(registry, adapter, SYSTEM, "pages.set_modules", { pageId, blocks });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect((r.error as { message?: string }).message).toContain("both synced and unsynced");
    }
    const after = await placed(SYSTEM, pageId);
    expect(after.header?.[0]?.syncMode).toBe("unsynced");
    expect(after.content?.[0]?.syncMode).toBe("synced");
  });

  // add_module names every placement it keeps; it states their modes too.
  for (const mode of ["live", "chat branch"] as const) {
    for (const syncedIn of ["header", "content"] as const) {
      it(`placing another module keeps the ${syncedIn} one synced (${mode})`, async () => {
        const ctx = mode === "live" ? SYSTEM : await chatCtx(`place-${syncedIn}`);
        const { pageId, cta, shared } = await seedShared(
          ctx,
          `place-${syncedIn}-${mode.replace(" ", "")}`,
          syncedIn,
        );
        const extra = await makeModule(`${PFX}-place-${syncedIn}-${mode.replace(" ", "")}-x`);
        await op(ctx, "pages.place_module", {
          target: { kind: "pages", pageIds: [pageId] },
          blockName: "content",
          position: "top",
          module: { moduleId: extra },
        });
        const after = await placed(ctx, pageId);
        const ctaIn = (b: Block) => after[b]?.find((m) => m.moduleId === cta);
        expect(ctaIn(syncedIn)).toMatchObject({ contentInstanceId: shared, syncMode: "synced" });
        expect(ctaIn(other(syncedIn))).toMatchObject({
          contentInstanceId: shared,
          syncMode: "unsynced",
        });
        expect(after.content?.[0]?.moduleId).toBe(extra);
      });
    }
  }
});

describe("#1663 — remove_module_from on a layout holding a module twice", () => {
  it("refuses unaddressed, removes the named block's placement, or all with allPlacements", async () => {
    const logo = await makeModule(`${PFX}-logo`);
    for (const blockName of ["header", "footer"]) {
      await op(SYSTEM, "layout_modules.set", { layoutId, blockName, moduleIds: [logo] });
    }
    const blockOf = async (blockName: string) =>
      (await op<{ moduleIds: string[] }>(SYSTEM, "layout_modules.get", { layoutId, blockName }))
        .moduleIds;

    const unaddressed = await remove(SYSTEM, {
      target: "layout",
      targetRef: layoutSlug,
      moduleId: logo,
    });
    expect(unaddressed.ok).toBe(false);
    expect(unaddressed.content).toContain('block "header" position 0');
    expect(unaddressed.content).toContain('block "footer" position 0');
    expect(await blockOf("header")).toEqual([logo]);

    const footerOnly = await remove(SYSTEM, {
      target: "layout",
      targetRef: layoutSlug,
      moduleId: logo,
      blockName: "footer",
    });
    expect(footerOnly.ok).toBe(true);
    expect(await blockOf("header")).toEqual([logo]);
    expect(await blockOf("footer")).toEqual([]);

    await op(SYSTEM, "layout_modules.set", { layoutId, blockName: "footer", moduleIds: [logo] });
    const all = await remove(SYSTEM, {
      target: "layout",
      targetRef: layoutId,
      moduleId: logo,
      allPlacements: true,
    });
    expect(all.ok).toBe(true);
    expect(await blockOf("header")).toEqual([]);
    expect(await blockOf("footer")).toEqual([]);
  });
});

describe("remove_module_from — target='layout'", () => {
  it("detaches from the layout block (by layout slug), module row survives", async () => {
    const modId = await makeModule(`${PFX}-lmod`);
    const set = await execute(registry, adapter, SYSTEM, "layout_modules.set", {
      layoutId,
      blockName: "footer",
      moduleIds: [modId],
    });
    expect(set.ok).toBe(true);

    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "layout", targetRef: layoutSlug, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("detached");

    const after = await execute(registry, adapter, SYSTEM, "layout_modules.get", {
      layoutId,
      blockName: "footer",
    });
    if (!after.ok) throw new Error("layout_modules.get");
    expect((after.value as { moduleIds: string[] }).moduleIds).not.toContain(modId);
    expect(await moduleExists(modId)).toBe(true);
  });

  it("also resolves the layout by uuid", async () => {
    const modId = await makeModule(`${PFX}-lmod2`);
    await execute(registry, adapter, SYSTEM, "layout_modules.set", {
      layoutId,
      blockName: "header",
      moduleIds: [modId],
    });
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "layout", targetRef: layoutId, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it("fails when the module isn't attached to the layout", async () => {
    const modId = await makeModule(`${PFX}-lmodx`);
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "layout", targetRef: layoutSlug, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
  });
});
