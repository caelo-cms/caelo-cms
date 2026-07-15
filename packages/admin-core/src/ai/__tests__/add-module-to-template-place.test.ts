// SPDX-License-Identifier: MPL-2.0

/**
 * issue #243 — unit coverage for `add_module_to_template` place mode: an
 * existing moduleId is fanned out to every page bound to the template
 * WITHOUT a modules.create call (the reuse path CLAUDE.md §1A/§3.2
 * demands). Mint mode still chains modules.create.
 *
 * Fake-adapter pattern as in add-module-place-and-list.test.ts: the real
 * OperationRegistry validates op names/scopes; `runOperation` returns
 * controlled values and records the call sequence.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
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
function toolCtxWith(calls: string[]): ToolContext {
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
        case "modules.create":
          // Mint mode: hand back a real uuid so the downstream
          // pages.set_modules input validation accepts the moduleIds array.
          return ok({ moduleId: "11111111-1111-4111-8111-11111111be03" });
        case "pages.list":
          return ok({
            pages: [
              { id: PAGE_A, slug: "post-one", locale: "en", templateId: TEMPLATE_ID },
              { id: PAGE_B, slug: "post-two", locale: "en", templateId: TEMPLATE_ID },
              {
                id: "11111111-1111-4111-8111-1111111100c3",
                slug: "landing",
                locale: "en",
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
        case "pages.set_modules":
          return ok({});
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
    const res = await addModuleTool.handler(
      AI,
      {
        target: "template",
        targetRef: TEMPLATE_ID,
        blockName: "content",
        position: "bottom",
        moduleId: SHARED.id,
      },
      toolCtxWith(calls),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain(SHARED.id);
    expect(res.content).toContain("existing module");
    // Fanned out to both bound pages (2 of 2), not the third template's page.
    expect(res.content).toContain("2 of 2 pages");
    expect(calls).toContain("modules.get");
    expect(calls.filter((c) => c === "pages.set_modules")).toHaveLength(2);
    expect(calls).not.toContain("modules.create");
  });

  it("mint mode still chains modules.create (no regression)", async () => {
    const calls: string[] = [];
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
      toolCtxWith(calls),
    );
    expect(res.ok).toBe(true);
    expect(calls).toContain("modules.create");
    expect(calls).not.toContain("modules.get");
  });
});
