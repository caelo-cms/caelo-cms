// SPDX-License-Identifier: MPL-2.0

/**
 * #1538 — `makeListReadTool`'s paging contract against STUB ops that page
 * like the real ones: a `complete` tool pages in memory, an `offset` tool
 * hands `offset` + `limit` to the op, a `cursor` tool hands the cursor on
 * and re-reads a page the char cap cut, so `next cursor` continues right
 * after the last row shown. Before, a tool over a paging op sliced the op's
 * first page in memory and every offset past it answered nothing.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err } from "@caelo-cms/shared";
import { z } from "zod";
import { makeListReadTool } from "../_list-read-tool.js";
import { type ToolContext, ToolRegistry, type ToolResult } from "../dispatch.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "list-read-tool-test",
};

interface Row {
  readonly path: string;
}

/** 250 rows, sorted by path like an op ordered by a unique key. */
const ROWS: readonly Row[] = Array.from({ length: 250 }, (_v, i) => ({
  path: `/r/${String(i).padStart(3, "0")}`,
}));

function harness(handler: (input: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "stub.list",
      readScope: "request",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.any(),
      output: z.any(),
      handler: async (_ctx, input) => {
        calls.push(input as Record<string, unknown>);
        const r = handler(input as Record<string, unknown>);
        return (r && typeof r === "object" && "ok" in r ? r : { ok: true, value: r }) as never;
      },
    }),
  );
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  const toolCtx: ToolContext = { adapter, registry };
  return { calls, toolCtx };
}

async function run(
  tool: Parameters<ToolRegistry["register"]>[0],
  args: unknown,
  toolCtx: ToolContext,
): Promise<ToolResult> {
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg.dispatch(tool.name, args, AI, toolCtx);
}

const columns = [{ key: "path", value: (r: Row) => r.path }];
const base = {
  name: "stub_list",
  description: "Stub list.",
  opName: "stub.list",
  input: z.object({}).strict(),
  label: "rows",
  rows: (v: unknown) => (v as { rows: Row[] }).rows,
  columns,
  emptyMessage: "No rows at all.",
};

/** An op that pages by offset, with or without a total. */
function offsetOp(rows: readonly Row[], withTotal: boolean) {
  return (input: Record<string, unknown>) => {
    const offset = input.offset as number;
    const limit = input.limit as number;
    return {
      rows: rows.slice(offset, offset + limit),
      ...(withTotal ? { total: rows.length } : {}),
    };
  };
}

/** An op that pages by keyset cursor (the last path shown), like redirects.list. */
function cursorOp(rows: readonly Row[]) {
  return (input: Record<string, unknown>) => {
    const after = input.cursor as string | undefined;
    if (after !== undefined && !after.startsWith("after:")) {
      return err({ kind: "HandlerError", operation: "stub.list", message: "bad cursor" });
    }
    const rest = after ? rows.filter((r) => r.path > after.slice(6)) : rows;
    const page = rest.slice(0, input.limit as number);
    const last = page.at(-1);
    return {
      rows: page,
      total: rows.length,
      nextCursor: rest.length > page.length && last ? `after:${last.path}` : null,
    };
  };
}

function schemaProps(tool: { inputSchema: unknown }): Record<string, Record<string, unknown>> {
  return (tool.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
}

describe("complete paging", () => {
  const tool = makeListReadTool({ ...base, paging: { kind: "complete" } });

  it("pages the whole set in memory and counts it", async () => {
    const h = harness(() => ({ rows: ROWS }));
    const r = await run(tool, { offset: 200, limit: 20 }, h.toolCtx);
    expect(h.calls[0]).toEqual({});
    expect(r.content).toContain("rows[20]{path}:");
    expect(r.content).toContain("/r/200");
    expect(r.content).toContain("20 of 250 shown — next: offset=220");
  });

  it("says when an offset is past the last row", async () => {
    const h = harness(() => ({ rows: ROWS }));
    const r = await run(tool, { offset: 300 }, h.toolCtx);
    expect(r.content).toContain("offset 300 is past the last row: 250 rows.");
  });
});

describe("offset paging", () => {
  it("hands offset + limit to the op, so every offset reaches its rows", async () => {
    const tool = makeListReadTool({ ...base, paging: { kind: "offset", maxLimit: 100 } });
    const h = harness(offsetOp(ROWS, false));
    const r = await run(tool, { offset: 200, limit: 20 }, h.toolCtx);
    // One row past the page says whether more exist.
    expect(h.calls[0]).toEqual({ offset: 200, limit: 21 });
    expect(r.content).toContain("rows[20]{path}:");
    expect(r.content).toContain("  /r/200");
    expect(r.content).toContain("# rows 201-220 — more exist; next: offset=220.");
    const last = await run(tool, { offset: 240, limit: 20 }, h.toolCtx);
    expect(last.content).toContain("rows[10]");
    expect(last.content).toContain("# rows 241-250.");
    const past = await run(tool, { offset: 250 }, h.toolCtx);
    expect(past.content).toBe("No rows past offset 250.");
  });

  it("counts the whole set when the op returns a total, also unfiltered", async () => {
    const tool = makeListReadTool({
      ...base,
      paging: { kind: "offset", maxLimit: 100, total: (v) => (v as { total: number }).total },
    });
    const h = harness(offsetOp(ROWS, true));
    const r = await run(tool, {}, h.toolCtx);
    expect(h.calls[0]).toEqual({ offset: 0, limit: 50 });
    expect(r.content).toContain("# rows 1-50 of 250 — more exist; next: offset=50.");
    const past = await run(tool, { offset: 300 }, h.toolCtx);
    expect(past.content).toBe("No rows past offset 300 (250 in total).");
  });

  it("full asks for the largest page and lifts the size cap", async () => {
    const tool = makeListReadTool({ ...base, paging: { kind: "offset", maxLimit: 100 } });
    const h = harness(offsetOp(ROWS, false));
    const r = await run(tool, { full: true }, h.toolCtx);
    expect(h.calls[0]).toEqual({ offset: 0, limit: 101 });
    expect(r.content).toContain("rows[100]");
    expect(r.content).toContain("next: offset=100");
  });

  it("a page filter says it narrowed this page only and where the next page starts", async () => {
    const tool = makeListReadTool({ ...base, paging: { kind: "offset", maxLimit: 100 } });
    const h = harness(offsetOp(ROWS, false));
    const r = await run(tool, { filter: "/r/01", limit: 100 }, h.toolCtx);
    // /r/010…/r/019 of the first 100 rows.
    expect(r.content).toContain("rows[10]");
    expect(r.content).toContain(
      '# 10 matches in rows 1-100 (filter="/r/01" applied to this page) — more exist; next: offset=100.',
    );
  });

  it("the char cap cuts on whole rows and the next offset follows the last row shown", async () => {
    const wide = ROWS.map((r) => ({ path: `${r.path}/${"x".repeat(400)}` }));
    const tool = makeListReadTool({ ...base, paging: { kind: "offset", maxLimit: 100 } });
    const h = harness(offsetOp(wide, false));
    const r = await run(tool, { limit: 100 }, h.toolCtx);
    const shown = Number(/rows\[(\d+)\]/.exec(r.content)?.[1]);
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(100);
    expect(r.content).toContain(`next: offset=${shown}.`);
  });

  it("offers offset, not cursor, and caps limit at the op's page", () => {
    const tool = makeListReadTool({ ...base, paging: { kind: "offset", maxLimit: 100 } });
    const props = schemaProps(tool);
    expect(props.offset).toBeDefined();
    expect(props.cursor).toBeUndefined();
    expect(props.limit?.maximum).toBe(100);
  });
});

describe("cursor paging", () => {
  const tool = makeListReadTool({
    ...base,
    paging: {
      kind: "cursor",
      maxLimit: 100,
      nextCursor: (v) => (v as { nextCursor: string | null }).nextCursor,
      total: (v) => (v as { total: number }).total,
    },
    listParamDescriptions: { filter: "The op's own search." },
  });

  it("follows next cursor through every row and counts the table", async () => {
    const h = harness(cursorOp(ROWS));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 10; call++) {
      const r = await run(tool, { limit: 100, ...(cursor ? { cursor } : {}) }, h.toolCtx);
      seen.push(...[...r.content.matchAll(/^ {2}(\/r\/\d+)$/gm)].map((m) => m[1] as string));
      expect(r.content).toContain(" of 250");
      cursor = /next cursor: (\S+)/.exec(r.content)?.[1];
      if (!cursor) break;
    }
    expect(seen).toEqual(ROWS.map((r) => r.path));
    expect(h.calls[0]).toEqual({ limit: 100 });
  });

  it("re-reads a page the char cap cut, so the cursor continues after the last row shown", async () => {
    const wide = ROWS.map((r) => ({ path: `${r.path}/${"x".repeat(400)}` }));
    const h = harness(cursorOp(wide));
    const r = await run(tool, { limit: 100 }, h.toolCtx);
    const shown = Number(/rows\[(\d+)\]/.exec(r.content)?.[1]);
    expect(shown).toBeLessThan(100);
    expect(h.calls.map((c) => c.limit)).toEqual([100, shown]);
    const next = /next cursor: (\S+)/.exec(r.content)?.[1];
    expect(next).toBe(`after:${wide[shown - 1]?.path}`);
  });

  it("answers the end of the list and passes an op's cursor error on", async () => {
    const h = harness(cursorOp(ROWS));
    const end = await run(tool, { cursor: "after:/r/999" }, h.toolCtx);
    expect(end.content).toBe("No more rows.");
    const bad = await run(tool, { cursor: "nope" }, h.toolCtx);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("bad cursor");
  });

  it("offers cursor, not offset", () => {
    const props = schemaProps(tool);
    expect(props.cursor).toBeDefined();
    expect(props.offset).toBeUndefined();
    expect(props.full?.description).toBe("true = 100 rows, no size cap.");
  });

  it("refuses a server-side filter that does not say what it matches", () => {
    expect(() =>
      makeListReadTool({
        ...base,
        paging: { kind: "cursor", maxLimit: 100, nextCursor: () => null },
      }),
    ).toThrow("listParamDescriptions.filter");
  });
});
