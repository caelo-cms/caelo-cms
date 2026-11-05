// SPDX-License-Identifier: MPL-2.0

/**
 * #1424 — `list_modules`, `get_module_impact` and the delete guard answer
 * "where is this module placed?" from one view, the caller's chat branch:
 * an AI that reads "unplaced" and deletes must never lose a placement.
 *
 * #1433 — a dot path a field cannot answer is refused where it is authored.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { createDefaultToolRegistry, type ToolContext } from "../ai/tools/index.js";
import { MODULE_USAGE_COUNT_CAP } from "../ops/content/module-placements.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = `mpv-${Date.now().toString(36)}`;
const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: `${P}-sys`,
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let toolCtx: ToolContext;
const tools = createDefaultToolRegistry();
let templateId = "";
let layoutId = "";

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function openChat(label: string, isolation?: "experiment"): Promise<ExecutionContext> {
  const s = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${P}-${label}`,
    ...(isolation ? { isolation } : {}),
  });
  return {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: `${P}-${label}`,
    chatBranchId: s.chatBranchId,
    chatTaskId: s.chatSessionId,
  };
}

async function dispatch(name: string, args: unknown, ctx: ExecutionContext) {
  return tools.dispatch(name, args, ctx, {
    ...toolCtx,
    ...(ctx.chatTaskId ? { chatSessionId: ctx.chatTaskId } : {}),
    ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
  });
}

async function createModule(slug: string): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${P}-${slug}`,
      displayName: `${P} ${slug}`,
      html: "<section>{{heading}}</section>",
      fields: [{ name: "heading", kind: "text", label: "Heading", default: "Hi" }],
    })
  ).moduleId;
}

async function createPage(slug: string): Promise<string> {
  return (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${P}-${slug}`,
      shortTitle: slug,
      title: slug,
      templateId,
    })
  ).pageId;
}

function place(ctx: ExecutionContext, pageId: string, moduleIds: string[]): Promise<unknown> {
  return op(ctx, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds }],
  });
}

/** The `list_modules` row of one module. */
async function catalogRow(ctx: ExecutionContext, moduleId: string): Promise<string> {
  const r = await dispatch("list_modules", { filter: P, full: true }, ctx);
  if (!r.ok) throw new Error(r.content);
  const line = r.content.split("\n").find((l) => l.includes(moduleId));
  if (line === undefined) throw new Error(`${moduleId} not listed:\n${r.content}`);
  return line;
}

interface Impact {
  affectedPages: { pageId: string; blockName: string; templateId: string; templateSlug: string }[];
  affectedPagesCapped: boolean;
  layouts: string[];
  nestedIn: string[];
  severity: string;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  toolCtx = { adapter, registry };
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${P}-tpl`,
      displayName: "Placement view",
      html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  layoutId = (
    await op<{ layoutId: string }>(SYS, "layouts.create", {
      slug: `${P}-layout`,
      displayName: "Placement view layout",
      html: `<!doctype html><html><head><title>L</title></head><body><caelo-slot name="header">_</caelo-slot><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
      blocks: [
        { name: "header", displayName: "Header", position: 0 },
        { name: "content", displayName: "Content", position: 1 },
      ],
    })
  ).layoutId;
});

afterAll(async () => {
  await adapter.close();
});

describe("#1424 one placement view", () => {
  it("add_module on a page: list_modules, get_module_impact and the delete guard agree", async () => {
    const moduleId = await createModule("placed");
    const pageId = await createPage("placed");
    const chat = await openChat("placed");

    const added = await dispatch(
      "add_module",
      { target: "page", targetRef: pageId, blockName: "content", position: 0, moduleId },
      // The AI cold-start gate is about a fresh site, not about this view.
      { ...chat, actorKind: "system" },
    );
    expect(added.content).toContain("added to page");

    const row = await catalogRow(chat, moduleId);
    expect(row).not.toContain("unplaced");
    expect(row).toContain(`/${P}-placed`);

    const impact = await dispatch("get_module_impact", { moduleId }, chat);
    expect(impact.content).toContain("1 page placement(s)");

    const del = await dispatch("delete_modules_many", { moduleIds: [moduleId] }, chat);
    expect(del.content).toContain("still placed");

    // Main still has no such placement: nothing was staged.
    const main = await op<{ affectedPages: unknown[] }>(SYS, "snapshots.module_impact", {
      moduleId,
    });
    expect(main.affectedPages).toEqual([]);
  });

  it("a placement the chat removed reads as unplaced, and the delete goes through", async () => {
    const moduleId = await createModule("removed");
    const other = await createModule("removed-other");
    const pageId = await createPage("removed");
    await place(SYS, pageId, [moduleId]);
    const chat = await openChat("removed");
    expect(await catalogRow(chat, moduleId)).not.toContain("unplaced");

    await place(chat, pageId, [other]);
    expect(await catalogRow(chat, moduleId)).toContain("unplaced");
    expect((await op<Impact>(chat, "snapshots.module_impact", { moduleId })).affectedPages).toEqual(
      [],
    );
    const del = await op<{ deleted: number }>(chat, "modules.delete_many", {
      moduleIds: [moduleId],
    });
    expect(del.deleted).toBe(1);

    // The live placement stands for everyone else.
    expect(await catalogRow({ ...SYS }, moduleId)).not.toContain("unplaced");
  });

  it("a page the chat deleted no longer counts, with or without a pending layout", async () => {
    const live = await createModule("page-gone");
    const pending = await createModule("page-gone-pending");
    const pageId = await createPage("page-gone");
    await place(SYS, pageId, [live]);
    const chat = await openChat("page-gone");
    await place(chat, pageId, [live, pending]);
    expect(await catalogRow(chat, pending)).not.toContain("unplaced");

    await op(chat, "pages.delete", { pageId });
    expect(await catalogRow(chat, live)).toContain("unplaced");
    expect(await catalogRow(chat, pending)).toContain("unplaced");
  });

  it("another chat's isolated page is invisible; a newer draft state replaces an older one", async () => {
    const moduleId = await createModule("other-chat");
    const other = await createModule("other-chat-b");
    const pageId = await createPage("other-chat");
    const experiment = await openChat("experiment", "experiment");
    await place(experiment, pageId, [moduleId]);
    expect(await catalogRow(experiment, moduleId)).not.toContain("unplaced");

    // Two chats on the shared draft: the later layout decides for both.
    const a = await openChat("draft-a");
    const b = await openChat("draft-b");
    expect(await catalogRow(a, moduleId)).toContain("unplaced");
    await place(a, pageId, [moduleId]);
    expect(await catalogRow(b, moduleId)).not.toContain("unplaced");
    // The first try is the stale-draft conflict, which counts as the re-read.
    await place(b, pageId, [other]).catch(() => undefined);
    await place(b, pageId, [other]);
    expect(await catalogRow(a, moduleId)).toContain("unplaced");
    expect((await op<Impact>(a, "snapshots.module_impact", { moduleId })).affectedPages).toEqual(
      [],
    );
  });

  it("names block and template for a pending placement", async () => {
    const moduleId = await createModule("block-name");
    const pageId = await createPage("block-name");
    const chat = await openChat("block-name");
    await place(chat, pageId, [moduleId]);
    const impact = await op<Impact>(chat, "snapshots.module_impact", { moduleId });
    expect(impact.affectedPages).toHaveLength(1);
    expect(impact.affectedPages[0]).toMatchObject({
      pageId,
      blockName: "content",
      templateId,
      templateSlug: `${P}-tpl`,
    });
  });

  it("layout chrome and a nesting parent are placed too, exactly as the guard says", async () => {
    const chrome = await createModule("chrome");
    await op(SYS, "layout_modules.set", { layoutId, blockName: "header", moduleIds: [chrome] });
    const chat = await openChat("chrome");
    expect(await catalogRow(chat, chrome)).toContain(`layout ${P}-layout`);
    const impact = await op<Impact>(chat, "snapshots.module_impact", { moduleId: chrome });
    expect(impact.layouts).toEqual([`${P}-layout`]);
    expect(impact.severity).toBe("high");

    const child = await createModule("child");
    const childContent = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: child,
      displayName: "Child",
      purpose: "test",
      values: { heading: "Nested" },
    });
    const parent = (
      await op<{ moduleId: string }>(SYS, "modules.create", {
        slug: `${P}-parent`,
        displayName: `${P} parent`,
        html: "<div>{{>slot}}</div>",
        fields: [{ name: "slot", kind: "module", label: "Slot" }],
      })
    ).moduleId;
    await op(SYS, "content_instances.create", {
      moduleId: parent,
      displayName: "Parent",
      purpose: "test",
      values: { slot: { moduleId: child, contentInstanceId: childContent.contentInstanceId } },
    });
    expect(await catalogRow(chat, child)).toContain(`nested in ${P}-parent`);
    const del = await dispatch("delete_modules_many", { moduleIds: [child] }, chat);
    expect(del.content).toContain("still placed");
  });

  it("stops counting at the cap and says so", async () => {
    const moduleId = await createModule("capped");
    const pageId = await createPage("capped");
    const chat = await openChat("capped");
    await place(
      chat,
      pageId,
      Array.from({ length: MODULE_USAGE_COUNT_CAP + 2 }, () => moduleId),
    );
    expect(await catalogRow(chat, moduleId)).toContain(`${MODULE_USAGE_COUNT_CAP}+ (`);
  });

  it("only the shown page of the catalog is read, and the rows past it stay reachable", async () => {
    const a = await createModule("window-a");
    const b = await createModule("window-b");
    const pageId = await createPage("window");
    await place(SYS, pageId, [a, b]);
    const chat = await openChat("window");
    const first = await dispatch("list_modules", { filter: `${P}-window`, limit: 1 }, chat);
    expect(first.content).toContain("next: offset=1");
    const second = await dispatch(
      "list_modules",
      { filter: `${P}-window`, limit: 1, offset: 1 },
      chat,
    );
    expect(second.content).not.toContain("unplaced");
    expect(second.content).toContain(`/${P}-window`);
  });
});

describe("#1433 a dot path its field cannot answer is refused at write", () => {
  const LINK_FIELD = [{ name: "primary_cta", kind: "link", label: "CTA" }];

  it("modules.create names the supported form; nothing is saved", async () => {
    const r = await execute(registry, adapter, SYS, "modules.create", {
      slug: `${P}-bad-path`,
      displayName: `${P} bad path`,
      html: '<a href="{{primary_cta.href}}">{{primary_cta.label}}</a>',
      fields: LINK_FIELD,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const message = (r.error as { message?: string }).message ?? "";
    expect(message).toContain("{{primary_cta.label}}");
    expect(message).toContain("{{primary_cta.href}}");
    expect(message).toContain("`primary_cta_label`");
  });

  it("modules.update refuses a new path and a field change that breaks one, not a rename", async () => {
    const { moduleId } = await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${P}-update-path`,
      displayName: `${P} update path`,
      html: '<a href="{{primary_cta.href}}">Go</a>',
      fields: LINK_FIELD,
    });
    const badHtml = await execute(registry, adapter, SYS, "modules.update", {
      moduleId,
      html: "<a>{{primary_cta.label}}</a>",
    });
    expect(badHtml.ok).toBe(false);
    const badField = await execute(registry, adapter, SYS, "modules.update", {
      moduleId,
      fields: [{ name: "primary_cta", kind: "url", label: "CTA" }],
    });
    expect(badField.ok).toBe(false);
    await op(SYS, "modules.update", { moduleId, displayName: `${P} renamed` });
  });
});
