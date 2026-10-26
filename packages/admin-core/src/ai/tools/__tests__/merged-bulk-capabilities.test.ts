// SPDX-License-Identifier: MPL-2.0

/**
 * Everything a retired singular tool reported or did must survive in the
 * bulk tool that replaced it:
 *
 * - update_modules_many (edit_module): per-item theme binding, the css-var
 *   and design-guard suffixes, the extractor's minted field names, an error
 *   when nothing was updated; modules.update_many hands `extractedFields`
 *   through instead of dropping it.
 * - set_content_instance_values_many: where each edit propagated.
 * - autofill_page_seo_many: which pages already had exactly that text.
 * - create_content_instances: an item's guard refusal stays a refusal
 *   (content_instances.create_many no longer drops the flag).
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  OperationAbortError,
  OperationRegistry,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import {
  createContentInstanceOp,
  createContentInstancesManyOp,
} from "../../../ops/content/content-instances.js";
import { updateModuleOp, updateModulesManyOp } from "../../../ops/content/modules.js";
import { registerAdminOps } from "../../../register.js";
import { autofillPageSeoManyTool } from "../autofill-page-seo.js";
import { extractedFieldsHint, updateModulesManyTool } from "../bulk-pages-modules.js";
import { createContentInstancesTool } from "../create-content-instances.js";
import type { ToolContext } from "../dispatch.js";
import {
  reachSummary,
  setContentInstanceValuesManyTool,
} from "../set-content-instance-values-many.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "merged-bulk-capabilities-unit",
};
const M1 = "11111111-1111-4111-8111-111111111101";
const M2 = "11111111-1111-4111-8111-111111111102";
const P1 = "11111111-1111-4111-8111-1111111111a1";
const P2 = "11111111-1111-4111-8111-1111111111a2";

const TOKENS = { color: { primary: { $type: "color", $value: "#4f46e5" } } };

const registry = new OperationRegistry();
registerAdminOps(registry);

type Handler = (input: unknown) => unknown;

/** Adapter answering each op from `handlers` (default `ok({})`), recording inputs. */
function toolCtx(handlers: Record<string, Handler>, calls: { op: string; input: unknown }[] = []) {
  const adapter = {
    runOperation: async (op: { name: string }, _ctx: unknown, input: unknown) => {
      calls.push({ op: op.name, input });
      const h = handlers[op.name];
      return h ? h(input) : ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

const themed = { "themes.get_active": () => ok({ theme: { tokens: TOKENS } }) };

describe("update_modules_many — ported edit_module capabilities", () => {
  it("binds each item's css to the theme before the write and reports it per item", async () => {
    const calls: { op: string; input: unknown }[] = [];
    const res = await updateModulesManyTool.handler(
      AI,
      {
        items: [
          { moduleId: M1, css: ".hero{color:#4f46e5}" },
          { moduleId: M2, css: ".card{color:#4f46e5}", bindThemeLiterals: false },
        ],
      },
      toolCtx(
        {
          ...themed,
          "modules.update_many": () =>
            ok({ updated: 2, notFound: 0, notFoundIds: [], failed: [], extracted: [] }),
          "modules.get": () => ok({ module: { html: '<section class="hero"></section>' } }),
        },
        calls,
      ),
    );
    expect(res.ok).toBe(true);
    const written = calls.find((c) => c.op === "modules.update_many")?.input as {
      updates: { moduleId: string; css: string; bindThemeLiterals?: boolean }[];
    };
    expect(written.updates[0]?.css).toBe(".hero{color:var(--color-primary)}");
    // Opt-out keeps the literal; the flag never reaches the op.
    expect(written.updates[1]?.css).toBe(".card{color:#4f46e5}");
    expect(written.updates.every((u) => u.bindThemeLiterals === undefined)).toBe(true);
    expect(res.content).toContain(`- ${M1}: updated`);
    expect(res.content).toContain("var(--color-primary)");
  });

  it("carries the design-guard findings per item (unscoped css)", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      { items: [{ moduleId: M1, html: '<section class="hero"></section>', css: "h1{margin:0}" }] },
      toolCtx({
        ...themed,
        "modules.update_many": () =>
          ok({ updated: 1, notFound: 0, notFoundIds: [], failed: [], extracted: [] }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("design-guard");
  });

  it("names the extractor's minted fields for the item that needed them", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      { items: [{ moduleId: M1, html: "<h1>Hello</h1>" }] },
      toolCtx({
        "modules.update_many": () =>
          ok({
            updated: 1,
            notFound: 0,
            notFoundIds: [],
            failed: [],
            extracted: [{ moduleId: M1, fields: [{ name: "h1Text", kind: "text" }] }],
          }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("h1Text (text)");
    expect(res.content).toContain("Extractor fallback used");
    expect(extractedFieldsHint([{ name: "a", kind: "text" }])).toContain("update_modules_many");
  });

  it("is an error when nothing was updated, naming each item's reason", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      {
        items: [
          { moduleId: M1, displayName: "A" },
          { moduleId: M2, displayName: "B" },
        ],
      },
      toolCtx({
        "modules.update_many": () =>
          ok({
            updated: 0,
            notFound: 1,
            notFoundIds: [M1],
            failed: [{ moduleId: M2, message: "module is being edited in another chat" }],
            extracted: [],
          }),
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain(`- ${M1}: module not found`);
    expect(res.content).toContain(`- ${M2}: not applied — module is being edited in another chat`);
  });

  it("stays ok on a partial batch (per-item commit) and reports the failure", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      {
        items: [
          { moduleId: M1, displayName: "A" },
          { moduleId: M2, displayName: "B" },
        ],
      },
      toolCtx({
        "modules.update_many": () =>
          ok({ updated: 1, notFound: 1, notFoundIds: [M2], failed: [], extracted: [] }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Updated 1 of 2 module(s)");
  });
});

/** A transaction stub: every query answers `rows` (the op's live-row read). */
function fakeTx(rows: unknown[]): TransactionRunner {
  return { execute: async () => rows } as unknown as TransactionRunner;
}

describe("modules.update_many — extractedFields pass-through", () => {
  const original = updateModuleOp.handler;
  afterEach(() => {
    (updateModuleOp as { handler: typeof original }).handler = original;
  });

  it("returns per-module extracted fields and the not-found ids", async () => {
    (updateModuleOp as { handler: typeof original }).handler = async () =>
      ok({ extractedFields: [{ name: "h1Text", kind: "text", label: "H1" }] }) as never;
    const r = await updateModulesManyOp.handler(
      AI,
      {
        updates: [
          { moduleId: M1, html: "<h1>Hi</h1>" },
          { moduleId: M2, displayName: "B" },
        ],
      },
      fakeTx([{ id: M1 }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.updated).toBe(1);
    expect(r.value.notFoundIds).toEqual([M2]);
    expect(r.value.extracted).toEqual([
      { moduleId: M1, fields: [{ name: "h1Text", kind: "text", label: "H1" }] },
    ]);
  });
});

describe("set_content_instance_values_many — reach per item", () => {
  it("names where each edit propagated", async () => {
    const res = await setContentInstanceValuesManyTool.handler(
      AI,
      {
        items: [
          { id: M1, values: {} },
          { id: M2, values: {} },
        ],
      },
      toolCtx({
        "content_instances.set_values_many": () =>
          ok({
            results: [
              { placementCount: 3, nestedParentCount: 0, version: 2 },
              { placementCount: 0, nestedParentCount: 2, version: 5 },
            ],
            count: 2,
          }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain(`- ${M1} -> v2. Propagated to 3 placement(s).`);
    expect(res.content).toContain(`- ${M2} -> v5. Nested in 2 parent content instance(s)`);
  });

  it("reachSummary distinguishes nested from orphan", () => {
    expect(reachSummary(0, 0)).toContain("Orphan");
    expect(reachSummary(1, 1)).toBe(
      "Propagated to 1 placement(s). Nested in 1 parent content instance(s) — shows wherever those render.",
    );
  });
});

describe("autofill_page_seo_many — alreadyFilled per item", () => {
  it("names the pages whose identical text changed nothing", async () => {
    const res = await autofillPageSeoManyTool.handler(
      AI,
      {
        items: [
          { pageId: P1, metaDescription: "One." },
          { pageId: P2, metaDescription: "Two." },
        ],
      },
      toolCtx({
        "pages_seo.autofill_many": () =>
          ok({ results: [{ alreadyFilled: false }, { alreadyFilled: true }], count: 2 }),
        // stage-readiness suffix reads the publish gate; nothing to say.
        "deploy.stage_readiness": () => ok({ ready: true, problems: [] }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("SEO autofilled on 1 page(s)");
    expect(res.content).toContain(
      `already had exactly this meta description — nothing changed: ${P2}`,
    );
  });
});

describe("create_content_instances — guard refusals stay refusals", () => {
  const original = createContentInstanceOp.handler;
  afterEach(() => {
    (createContentInstanceOp as { handler: typeof original }).handler = original;
  });
  const refuse = async () =>
    err({
      kind: "HandlerError" as const,
      operation: "content_instances.create",
      message: "field `body` carries a component pattern",
      refusal: true as const,
    });

  it("the op keeps `refusal` on the first item (nothing written yet)", async () => {
    (createContentInstanceOp as { handler: typeof original }).handler = refuse as never;
    const r = await createContentInstancesManyOp.handler(
      AI,
      { instances: [{ moduleId: M1, values: {} }] },
      fakeTx([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { refusal?: true }).refusal).toBe(true);
  });

  it("the op keeps `refusal` when a later item aborts the batch", async () => {
    let n = 0;
    (createContentInstanceOp as { handler: typeof original }).handler = (async () => {
      n += 1;
      return n === 1 ? ok({ contentInstanceId: M2 }) : refuse();
    }) as never;
    const run = createContentInstancesManyOp.handler(
      AI,
      {
        instances: [
          { moduleId: M1, values: {} },
          { moduleId: M1, values: {} },
        ],
      },
      fakeTx([]),
    );
    const thrown = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(OperationAbortError);
    expect(((thrown as OperationAbortError).queryError as { refusal?: true }).refusal).toBe(true);
  });

  it("the tool forwards the refusal and names `items[i]`", async () => {
    const res = await createContentInstancesTool.handler(
      AI,
      { items: [{ moduleId: M1, values: {} }] },
      toolCtx({
        "content_instances.create_many": () =>
          err({
            kind: "HandlerError",
            operation: "content_instances.create_many",
            message: "instances[0] (moduleId=x): refused",
            refusal: true,
          }),
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("items[0]");
    expect(res.content).not.toContain("instances[0]");
    expect((res as { refusal?: true }).refusal).toBe(true);
  });
});
