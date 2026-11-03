// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1260 — a draft conflict clears with the re-read it names.
 *
 * On the shared draft (#620) a write over another chat's newer change is a
 * conflict: "read it again, then redo your edit". Before #1260 only the
 * conflict itself recorded that the chat had seen the change, and a bulk
 * write (`content_instances.set_values_many`, international-site's
 * `apply_translations`) rolled that back when it aborted — while the reads
 * the AI then made (`get_content_instance`, `read_content`, the
 * translation's page read) recorded nothing. The chat conflicted forever.
 *
 *   - the conflict message names the exact tool call that re-reads;
 *   - that read (through the tool dispatcher) records the observation in a
 *     transaction of its own, so the redone write goes through;
 *   - `page_module_content.list_for_page` (the translation flow's read)
 *     counts as reading the page and every instance on it;
 *   - an op read made inside a write path does NOT count: it would let a
 *     write built on stale content overwrite the other chat's change.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type ToolContext, ToolRegistry } from "../ai/tools/dispatch.js";
import { getContentInstanceTool } from "../ai/tools/get-content-instance.js";
import { getListTool } from "../ai/tools/list-tools.js";
import { readContentTool } from "../ai/tools/read-content.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t1260-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let tools: ToolRegistry;
let templateId = "";
let cardId = "";

async function run(ctx: ExecutionContext, name: string, input: unknown) {
  return execute(registry, adapter, ctx, name, input);
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await run(ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** The error message of a call that must fail. */
async function refusal(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await run(ctx, name, input);
  if (r.ok) throw new Error(`${name} was expected to conflict, but it went through`);
  return JSON.stringify(r.error);
}

/** A new chat on the site's shared draft, as the AI acting in it. */
async function draftChat(title: string): Promise<ExecutionContext> {
  const v = await op<{ chatSessionId: string; chatBranchId: string; branchKind: string }>(
    SYS,
    "chat.create_session",
    { title: `t1260-${title}-${TS}` },
  );
  expect(v.branchKind).toBe("draft");
  return {
    actorId: HUMAN,
    actorKind: "ai",
    requestId: `t1260-${title}`,
    chatBranchId: v.chatBranchId,
    chatTaskId: v.chatSessionId,
  };
}

/** The tool call the AI makes, through the dispatcher (where reads are recorded). */
async function tool(ctx: ExecutionContext, name: string, args: unknown) {
  const toolCtx: ToolContext = {
    adapter,
    registry,
    ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
    ...(ctx.chatTaskId ? { chatSessionId: ctx.chatTaskId } : {}),
  };
  const r = await tools.dispatch(name, args, ctx, toolCtx);
  expect(r.ok).toBe(true);
  expect(r.content).not.toContain("could not be recorded");
  return r;
}

async function instance(title: string): Promise<string> {
  return (
    await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: cardId,
      values: { title },
    })
  ).contentInstanceId;
}

/** A live page with one card placement per title; returns the page and its instance ids. */
async function livePage(
  slug: string,
  titles: string[],
): Promise<{ pageId: string; ids: string[] }> {
  const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
    slug: `t1260-${slug}-${TS}`,
    shortTitle: slug,
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
  const placements = (
    await op<{ placements: { contentInstanceId: string }[] }>(
      SYS,
      "page_module_content.list_for_page",
      { pageId },
    )
  ).placements;
  return { pageId, ids: placements.map((p) => p.contentInstanceId) };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  tools = new ToolRegistry();
  tools.register(getContentInstanceTool);
  tools.register(readContentTool);
  tools.register(getListTool);
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `t1260-tpl-${TS}`,
      displayName: "T1260 tpl",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  cardId = (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `t1260-card-${TS}`,
      displayName: "T1260 card",
      html: "<p>{{title}}</p>",
      fields: [{ name: "title", kind: "text", label: "Title" }],
    })
  ).moduleId;
});

afterAll(async () => {
  await adapter.close();
});

describe("#1260 — a draft conflict clears with the re-read it names", () => {
  it("content instances in a batch: each named get_content_instance clears its conflict, then the batch lands", async () => {
    const x = await instance("x v0");
    const y = await instance("y v0");
    const a = await draftChat("a-ci");
    const b = await draftChat("b-ci");
    await op(a, "content_instances.set_values_many", {
      items: [
        { id: x, values: { title: "x from A" } },
        { id: y, values: { title: "y from A" } },
      ],
    });
    const batch = {
      items: [
        { id: x, values: { title: "x from B" } },
        { id: y, values: { title: "y from B" } },
      ],
    };

    const first = await refusal(b, "content_instances.set_values_many", batch);
    expect(first).toContain("Conflict: contentInstance");
    expect(first).toContain(`get_content_instance({id:\\"${x}\\"})`);
    // The bug: the aborted batch rolled back the conflict's own
    // observation, so resending without the re-read still conflicts.
    expect(await refusal(b, "content_instances.set_values_many", batch)).toContain(
      `get_content_instance({id:\\"${x}\\"})`,
    );

    await tool(b, "get_content_instance", { id: x });
    const second = await refusal(b, "content_instances.set_values_many", batch);
    expect(second).toContain(`get_content_instance({id:\\"${y}\\"})`);
    await tool(b, "get_content_instance", { id: y });

    await op(b, "content_instances.set_values_many", batch);
    const got = await op<{ instance: { values: Record<string, unknown> } }>(
      b,
      "content_instances.get",
      { id: y },
    );
    expect(got.instance.values).toEqual({ title: "y from B" });
  });

  it("a module: read_content clears the conflict; an op read inside a write path does not", async () => {
    const moduleId = (
      await op<{ moduleId: string }>(SYS, "modules.create", {
        slug: `t1260-mod-${TS}`,
        displayName: "T1260 mod",
        html: "<p>v0</p>",
      })
    ).moduleId;
    const a = await draftChat("a-mod");
    const b = await draftChat("b-mod");
    await op(a, "modules.update", { moduleId, html: "<p>from A</p>" });

    // A write tool's internal read (a design guard, the current-page
    // context) is no evidence the AI saw the change.
    await op(b, "modules.get", { moduleId });
    const message = await refusal(b, "modules.update", { moduleId, html: "<p>B stale</p>" });
    expect(message).toContain(
      `read_content({entityKind:\\"module\\", entityId:\\"${moduleId}\\"})`,
    );

    // A changes it again; this time B reads it with the named tool first,
    // so its write builds on what it read and goes through without a
    // conflict of its own having recorded anything.
    await op(a, "modules.update", { moduleId, html: "<p>from A, again</p>" });
    await tool(b, "read_content", { entityKind: "module", entityId: moduleId });
    await op(b, "modules.update", { moduleId, html: "<p>from A, again, then B</p>" });
  });

  it("the translation flow's page read counts as reading the page's instances", async () => {
    const { pageId, ids } = await livePage("translate", ["one", "two"]);
    const a = await draftChat("a-page");
    const b = await draftChat("b-page");
    await op(a, "content_instances.set_values_many", {
      items: ids.map((id, i) => ({ id, values: { title: `A ${i}` } })),
    });
    const batch = { items: ids.map((id, i) => ({ id, values: { title: `B ${i}` } })) };
    expect(await refusal(b, "content_instances.set_values_many", batch)).toContain(
      "Conflict: contentInstance",
    );

    // international-site's translate_variant / apply_translations read the
    // page through this op (as a plugin actor on the chat's branch).
    await op({ ...b, actorKind: "plugin" }, "page_module_content.list_for_page", { pageId });
    await op(b, "content_instances.set_values_many", batch);
  });

  it("a shared list: get_list clears the conflict it names", async () => {
    const slug = `t1260-list-${TS}`;
    await op(SYS, "lists.upsert_many", {
      lists: [{ slug, name: "T1260 list", purpose: "a test list", type: "texts", items: [] }],
    });
    const a = await draftChat("a-list");
    const b = await draftChat("b-list");
    const listOf = (n: string) => ({
      lists: [
        {
          slug,
          name: "T1260 list",
          purpose: "a test list",
          type: "texts",
          items: [{ node: "text", values: { text: n } }],
        },
      ],
    });
    await op(a, "lists.upsert_many", listOf("from A"));
    const message = await refusal(b, "lists.upsert_many", listOf("B stale"));
    const listId = (await op<{ list: { id: string } }>(b, "lists.get", { slug })).list.id;
    expect(message).toContain(`get_list({id:\\"${listId}\\"})`);

    // A changes it again; B reads it with the named tool first, so its
    // write goes through without a conflict of its own having recorded it.
    await op(a, "lists.upsert_many", listOf("from A, again"));
    await tool(b, "get_list", { id: listId });
    await op(b, "lists.upsert_many", listOf("from A, again, then B"));
  });
});
