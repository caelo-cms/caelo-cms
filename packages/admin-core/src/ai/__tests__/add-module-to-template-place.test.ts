// SPDX-License-Identifier: MPL-2.0

/**
 * issue #243 — unit coverage for `add_module_to_template` place mode: an
 * existing moduleId is fanned out to every page bound to the template
 * WITHOUT minting (the reuse path CLAUDE.md §1A/§3.2 demands). Mint mode
 * hands the `modules.create` input to `pages.place_module`, which creates
 * the module in the placement's transaction (#1246).
 *
 * Fake-adapter pattern as in add-module-place-and-list.test.ts: the real
 * OperationRegistry validates op names/scopes; `runOperation` returns
 * controlled values and records the call sequence.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { PLACE_MODULE_MAX_PAGES } from "../../ops/content/place-module.js";
import { registerAdminOps } from "../../register.js";
import { addModuleTool } from "../tools/add-module.js";
import type { ToolContext } from "../tools/dispatch.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-243-unit",
};

const TEMPLATE_ID = "11111111-1111-4111-8111-11111111feed";
const SHARED = {
  id: "11111111-1111-4111-8111-11111111be02",
  slug: "post-footer",
  displayName: "Post footer",
};
const PAGE_A = "11111111-1111-4111-8111-1111111100a1";
const PAGE_B = "11111111-1111-4111-8111-1111111100b2";

/**
 * Fake adapter satisfying the cold-start gate (identity + brand theme so
 * the AI actor isn't blocked) plus the ops the tool chains. Two pages are
 * bound to TEMPLATE_ID; a third page on another template must be skipped.
 */
function toolCtxWith(calls: string[], inputs: Record<string, unknown>[] = []): ToolContext {
  const adapter = {
    // execute() calls runOperation(op, ctx, parsedInput).
    runOperation: async (op: { name: string }, _ctx: unknown, input: Record<string, unknown>) => {
      calls.push(op.name);
      switch (op.name) {
        case "site_defaults.get":
          return ok({ defaults: { siteName: "Acme", sitePurpose: "SaaS marketing site" } });
        case "themes.get_active":
          return ok({
            theme: {
              origin: "ai",
              description: "Indigo B2B palette",
              tokens: { color: { primary: { $value: "#4f46e5" } } },
            },
          });
        case "modules.get":
          return ok({ module: SHARED });
        case "pages.list":
          return ok({
            pages: [
              { id: PAGE_A, slug: "post-one", templateId: TEMPLATE_ID },
              { id: PAGE_B, slug: "post-two", templateId: TEMPLATE_ID },
              {
                id: "11111111-1111-4111-8111-1111111100c3",
                slug: "landing",
                templateId: "22222222-2222-4222-8222-222222222222",
              },
            ],
          });
        case "pages.get_with_modules": {
          const pageId = input.pageId as string;
          return ok({
            page: {
              id: pageId,
              templateId: TEMPLATE_ID,
              blocks: [{ blockName: "content", modules: [] }],
            },
          });
        }
        case "pages.place_module": {
          inputs.push(input);
          const pageIds = (input.target as { pageIds: string[] }).pageIds;
          const module = input.module as { moduleId?: string };
          return ok({
            moduleId: module.moduleId ?? "11111111-1111-4111-8111-11111111be03",
            minted: module.moduleId === undefined,
            placements: pageIds.map((pageId) => ({
              pageId,
              position: 0,
              contentInstanceId: "11111111-1111-4111-8111-11111111c1c1",
            })),
            layoutPosition: null,
          });
        }
        default:
          return ok({});
      }
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("add_module (target='template') place mode (issue #243)", () => {
  it("fans an existing module out to every bound page without minting a duplicate", async () => {
    const calls: string[] = [];
    const inputs: Record<string, unknown>[] = [];
    const res = await addModuleTool.handler(
      AI,
      {
        target: "template",
        targetRef: TEMPLATE_ID,
        blockName: "content",
        position: "bottom",
        moduleId: SHARED.id,
      },
      toolCtxWith(calls, inputs),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain(SHARED.id);
    expect(res.content).toContain("existing module");
    // Fanned out to both bound pages (2 of 2), not the third template's page.
    expect(res.content).toContain("2 of 2 pages");
    expect(calls).toContain("modules.get");
    // #1246 — one transaction for the whole fan-out, both pages in it.
    expect(calls.filter((c) => c === "pages.place_module")).toHaveLength(1);
    expect(inputs[0]?.target).toEqual({ kind: "pages", pageIds: [PAGE_A, PAGE_B] });
    expect(calls).not.toContain("modules.create");
  });

  it("refuses a fan-out above the one-transaction cap with what to do instead", async () => {
    const calls: string[] = [];
    const base = toolCtxWith(calls);
    const many = Array.from({ length: PLACE_MODULE_MAX_PAGES + 1 }, (_, i) => ({
      id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      slug: `p${i}`,
      templateId: TEMPLATE_ID,
    }));
    const adapter = {
      runOperation: async (op: { name: string }, c: unknown, input: Record<string, unknown>) =>
        op.name === "pages.list"
          ? ok({ pages: many })
          : (base.adapter as unknown as { runOperation: typeof adapter.runOperation }).runOperation(
              op,
              c,
              input,
            ),
    };
    const res = await addModuleTool.handler(
      AI,
      {
        target: "template",
        targetRef: TEMPLATE_ID,
        blockName: "content",
        position: "bottom",
        moduleId: SHARED.id,
      },
      { adapter, registry } as unknown as ToolContext,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("nothing was written");
    expect(res.content).toContain("target='layout'");
    expect(calls).not.toContain("pages.place_module");
  });

  it("mint mode creates the module inside the placement op (no separate modules.create)", async () => {
    const calls: string[] = [];
    const inputs: Record<string, unknown>[] = [];
    const res = await addModuleTool.handler(
      AI,
      {
        target: "template",
        targetRef: TEMPLATE_ID,
        blockName: "content",
        position: "bottom",
        displayName: "Fresh footer",
        html: "<footer>{{copyright}}</footer>",
        fields: [{ name: "copyright", kind: "text", label: "Copyright" }],
      },
      toolCtxWith(calls, inputs),
    );
    expect(res.ok).toBe(true);
    expect(calls).not.toContain("modules.create");
    expect(calls).not.toContain("modules.get");
    const module = inputs[0]?.module as { create?: { displayName: string } };
    expect(module.create?.displayName).toBe("Fresh footer");
  });
});
