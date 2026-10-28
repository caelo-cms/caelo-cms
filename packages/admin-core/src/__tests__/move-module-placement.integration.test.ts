// SPDX-License-Identifier: MPL-2.0

/**
 * #1195 — `move_module` moves ONE placement. A module placed several times
 * keeps its other placements (in the source and the target block), every
 * placement keeps its own content — the moved one too, across blocks — and
 * an unaddressed or unknown placement is refused with the valid ones named.
 * Real Postgres (§6), both the live and the chat-branched write path.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, moveModuleToolInput } from "@caelo-cms/shared";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { moveModuleTool } from "../ai/tools/move-module.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i1195",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

type Blocks = {
  blockName: string;
  modules: { moduleId: string; contentInstanceId: string | null }[];
}[];

async function blocksOf(ctx: ExecutionContext, pageId: string): Promise<Blocks> {
  return (await op<{ page: { blocks: Blocks } }>(ctx, "pages.get_with_modules", { pageId })).page
    .blocks;
}

/** Each block as `module:body` labels, so content travels visibly. */
async function labelled(ctx: ExecutionContext, pageId: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const b of await blocksOf(ctx, pageId)) {
    out[b.blockName] = [];
    for (const m of b.modules) {
      const ci = await op<{ instance: { values: { body?: string } } }>(
        ctx,
        "content_instances.get",
        { id: m.contentInstanceId },
      );
      out[b.blockName]?.push(ci.instance.values.body ?? "");
    }
  }
  return out;
}

/** header: [M "x"], content: [M "a", N "n", M "b"]. */
async function seedPage(ctx: ExecutionContext, slug: string) {
  const mk = async (s: string) =>
    (
      await op<{ moduleId: string }>(SYSTEM, "modules.create", {
        slug: `i1195-${s}-${slug}-${TS}`,
        displayName: s,
        html: "<div>{{body}}</div>",
        fields: [{ name: "body", kind: "text", label: "Body" }],
      })
    ).moduleId;
  const m = await mk("m");
  const n = await mk("n");
  const { pageId } = await op<{ pageId: string }>(ctx, "pages.create", {
    slug: `i1195-${slug}-${TS}`,
    title: slug,
    templateId,
  });
  await op(ctx, "pages.set_modules", {
    pageId,
    blocks: [
      { blockName: "header", moduleIds: [m] },
      { blockName: "content", moduleIds: [m, n, m] },
    ],
  });
  const labels = ["x", "a", "n", "b"];
  let i = 0;
  for (const b of await blocksOf(ctx, pageId)) {
    for (const p of b.modules) {
      await op(ctx, "content_instances.set_values", {
        id: p.contentInstanceId,
        values: { body: labels[i++] },
      });
    }
  }
  return { pageId, m, n };
}

async function move(ctx: ExecutionContext, input: Record<string, unknown>) {
  return moveModuleTool.handler(ctx, moveModuleToolInput.parse(input), toolCtx());
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await op<{ templateId: string }>(SYSTEM, "templates.create", {
      slug: `i1195-tpl-${TS}`,
      displayName: "T",
      html: '<body><caelo-slot name="header">_</caelo-slot><caelo-slot name="content">_</caelo-slot></body>',
    })
  ).templateId;
  await op(SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [
      { name: "header", displayName: "Header", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
    ],
  });
});

afterAll(async () => {
  await adapter.close();
});

async function chatCtx(title: string): Promise<ExecutionContext> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(
    SYSTEM,
    "chat.create_session",
    { title: `i1195-${title}-${TS}` },
  );
  return {
    actorId: SYSTEM.actorId,
    actorKind: "ai",
    requestId: `i1195-${title}`,
    chatBranchId: v.chatBranchId,
    chatTaskId: v.chatSessionId,
  };
}

describe("#1195 — move_module moves one placement", () => {
  for (const mode of ["live", "chat branch"] as const) {
    it(`moves one of several placements across blocks, keeping all content (${mode})`, async () => {
      const ctx = mode === "live" ? SYSTEM : await chatCtx("cross");
      const { pageId, m } = await seedPage(ctx, `cross-${mode.replace(" ", "")}`);
      expect(await labelled(ctx, pageId)).toEqual({ header: ["x"], content: ["a", "n", "b"] });

      const res = await move(ctx, {
        pageId,
        moduleId: m,
        fromBlockName: "content",
        fromPosition: 2,
        toBlockName: "header",
        position: "top",
      });
      expect(res.ok).toBe(true);
      expect(await labelled(ctx, pageId)).toEqual({ header: ["b", "x"], content: ["a", "n"] });
    });
  }

  it("reorders one placement within a block without the other trading content", async () => {
    const { pageId, m } = await seedPage(SYSTEM, "reorder");
    const res = await move(SYSTEM, {
      pageId,
      moduleId: m,
      fromBlockName: "content",
      fromPosition: 2,
      position: "top",
    });
    expect(res.ok).toBe(true);
    expect(await labelled(SYSTEM, pageId)).toEqual({ header: ["x"], content: ["b", "a", "n"] });
  });

  it("refuses an unaddressed move of a repeated module, naming its placements", async () => {
    const { pageId, m } = await seedPage(SYSTEM, "ambiguous");
    const res = await move(SYSTEM, { pageId, moduleId: m, toBlockName: "header", position: 0 });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('block "header" position 0');
    expect(res.content).toContain('block "content" position 2');
    expect(res.content).toContain("fromBlockName + fromPosition");
    expect(await labelled(SYSTEM, pageId)).toEqual({ header: ["x"], content: ["a", "n", "b"] });
  });

  it("refuses a placement that does not exist, naming the valid ones", async () => {
    const { pageId, m } = await seedPage(SYSTEM, "missing");
    const res = await move(SYSTEM, {
      pageId,
      moduleId: m,
      fromBlockName: "content",
      fromPosition: 1,
      position: "top",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('no placement at block "content" position 1');
    expect(res.content).toContain('block "content" position 0');
  });
});
