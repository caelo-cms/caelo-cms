// SPDX-License-Identifier: MPL-2.0

/**
 * #1264 — op names in an error are dead ends for the AI (it calls tools).
 * The map is applied centrally: `describeError` and every failed result of
 * `ToolRegistry.dispatch`, whatever tool produced it.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { toolNamesIn } from "../../op-tool-names.js";
import { describeError } from "../_describe-error.js";
import { type ToolContext, ToolRegistry } from "../dispatch.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "op-tool-names",
};

describe("toolNamesIn", () => {
  it("maps op names to the tools that do the same", () => {
    expect(toolNamesIn("edit that list (lists.patch_items_many) instead")).toBe(
      "edit that list (patch_list_items_many) instead",
    );
    expect(toolNamesIn("page_module_content.set_many failed")).toBe(
      "set_page_module_content_many failed",
    );
    expect(toolNamesIn("change it with modules.update.")).toBe(
      "change it with update_modules_many.",
    );
  });

  it("prefers the longer op name and leaves longer identifiers alone", () => {
    expect(toolNamesIn("pages.update_many and pages.update")).toBe(
      "update_pages_many and update_pages_many",
    );
    expect(toolNamesIn("lists.get_x x.lists.get")).toBe("lists.get_x x.lists.get");
  });

  it("is idempotent and keeps ops several tools wrap", () => {
    const once = toolNamesIn("lists.get then list_types.get, pages.set_modules");
    expect(toolNamesIn(once)).toBe(once);
    expect(once).toContain("pages.set_modules");
  });
});

describe("central mapping", () => {
  it("describeError names tools", () => {
    expect(
      describeError({
        kind: "HandlerError",
        operation: "x",
        message: "edit that list (lists.patch_items_many) instead",
      }),
    ).toBe("edit that list (patch_list_items_many) instead");
  });

  it("dispatch maps every failed result, including the nextAction reason, and leaves ok results", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "fails_with_op_names",
      description: "test",
      schema: z.object({ fail: z.boolean() }).strict(),
      handler: async (_ctx, input) =>
        input.fail
          ? {
              ok: false,
              content: "page_module_content.set_many failed: use lists.patch_items_many",
              nextAction: { tool: "get_list", reason: "lists.get shows the entry ids" },
            }
          : { ok: true, content: "the page text mentions lists.get verbatim" },
    });
    const toolCtx = {} as ToolContext;
    const failed = await tools.dispatch("fails_with_op_names", { fail: true }, AI, toolCtx);
    expect(failed.ok).toBe(false);
    expect(failed.content).toBe("set_page_module_content_many failed: use patch_list_items_many");
    expect(failed.nextAction?.reason).toBe("get_list shows the entry ids");
    const passed = await tools.dispatch("fails_with_op_names", { fail: false }, AI, toolCtx);
    expect(passed.content).toBe("the page text mentions lists.get verbatim");
  });
});
