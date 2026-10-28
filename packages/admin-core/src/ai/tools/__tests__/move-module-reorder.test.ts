// SPDX-License-Identifier: MPL-2.0

/**
 * move_module absorbed reorder_module: `toBlockName` omitted = the module's
 * current block, `up` / `down` move one slot (current block only), an index
 * is absolute and clamped, and a move onto the position the module already
 * holds is a no-op that writes nothing.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, moveModuleToolInput, ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../../register.js";
import type { ToolContext } from "../dispatch.js";
import { moveModuleTool, targetIndex } from "../move-module.js";

const PAGE = "11111111-1111-4111-8111-1111111111aa";
const [A, B, C, H] = [
  "11111111-1111-4111-8111-1111111111a1",
  "11111111-1111-4111-8111-1111111111b1",
  "11111111-1111-4111-8111-1111111111c1",
  "11111111-1111-4111-8111-1111111111d1",
];

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "move-module-reorder-unit",
};

const registry = new OperationRegistry();
registerAdminOps(registry);

/** Page with `header: [H]` and `content: [A, B, C]`; records set_modules writes. */
function pageCtx(writes: unknown[]): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }, _ctx: unknown, input: unknown) => {
      if (op.name === "pages.get_with_modules") {
        return ok({
          page: {
            id: PAGE,
            blocks: [
              { blockName: "header", modules: [{ moduleId: H }] },
              { blockName: "content", modules: [A, B, C].map((moduleId) => ({ moduleId })) },
            ],
          },
        });
      }
      if (op.name === "pages.set_modules") writes.push(input);
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

async function move(input: Record<string, unknown>) {
  const writes: unknown[] = [];
  const parsed = moveModuleToolInput.parse({ pageId: PAGE, ...input });
  const res = await moveModuleTool.handler(AI, parsed, pageCtx(writes));
  const content = (
    writes[0] as { blocks: { blockName: string; moduleIds: string[] }[] } | undefined
  )?.blocks.find((b) => b.blockName === "content")?.moduleIds;
  return { res, writes, content };
}

describe("move_module — reorder within the current block", () => {
  it("`up` without toBlockName moves one slot up", async () => {
    const { res, content } = await move({ moduleId: C, position: "up" });
    expect(res.ok).toBe(true);
    expect(content).toEqual([A, C, B]);
  });

  it("`down` moves one slot down", async () => {
    const { content } = await move({ moduleId: A, position: "down" });
    expect(content).toEqual([B, A, C]);
  });

  it("an index is absolute and clamped to the block end", async () => {
    const { content } = await move({ moduleId: A, position: 99 });
    expect(content).toEqual([B, C, A]);
  });

  it("`up` at the top is a no-op that writes nothing", async () => {
    const { res, writes } = await move({ moduleId: A, position: "up" });
    expect(res).toEqual({
      ok: true,
      content: 'module already at position 0 in block "content" — no-op',
    });
    expect(writes).toEqual([]);
  });

  it("`down` at the bottom and the module's own index are no-ops too", async () => {
    expect((await move({ moduleId: C, position: "down" })).writes).toEqual([]);
    expect((await move({ moduleId: B, position: 1 })).writes).toEqual([]);
  });

  it("naming the current block explicitly behaves the same", async () => {
    const { content } = await move({ moduleId: B, toBlockName: "content", position: "top" });
    expect(content).toEqual([B, A, C]);
  });
});

describe("move_module — across blocks", () => {
  it("moves into another block at a position", async () => {
    const writes: unknown[] = [];
    const res = await moveModuleTool.handler(
      AI,
      moveModuleToolInput.parse({ pageId: PAGE, moduleId: B, toBlockName: "header", position: 0 }),
      pageCtx(writes),
    );
    expect(res.ok).toBe(true);
    expect(writes[0]).toEqual({
      pageId: PAGE,
      blocks: [
        { blockName: "header", moduleIds: [B, H], contentInstanceIds: [null, null] },
        { blockName: "content", moduleIds: [A, C], contentInstanceIds: [null, null] },
      ],
    });
  });

  it("refuses up/down with another block, naming the valid choices", async () => {
    const { res, writes } = await move({ moduleId: B, toBlockName: "header", position: "up" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('current block ("content")');
    expect(writes).toEqual([]);
  });

  it("refuses an unknown block", async () => {
    const { res } = await move({ moduleId: B, toBlockName: "sidebar", position: "top" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("sidebar");
  });
});

describe("targetIndex (ported reorder math)", () => {
  it("matches reorder_module's relative + absolute semantics", () => {
    // base = block without the module; reorder clamped to len-1 = base.length
    expect(targetIndex("up", 0, 2)).toBe(0);
    expect(targetIndex("up", 2, 2)).toBe(1);
    expect(targetIndex("down", 2, 2)).toBe(2);
    expect(targetIndex("down", 0, 2)).toBe(1);
    expect(targetIndex(5, 0, 2)).toBe(2);
    expect(targetIndex("top", 2, 2)).toBe(0);
    expect(targetIndex("bottom", 0, 2)).toBe(2);
  });

  it("the shared schema accepts up/down and an omitted toBlockName", () => {
    expect(
      moveModuleToolInput.safeParse({ pageId: PAGE, moduleId: A, position: '"down"' }).success,
    ).toBe(true);
    expect(moveModuleToolInput.safeParse({ pageId: PAGE, moduleId: A }).success).toBe(false);
  });
});
