// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (AC#1 hardening) — assert the generation-time blockName enum
 * is actually emitted by BOTH tools that carry it, not just by the shared
 * withBlockNameEnum helper in the abstract.
 *
 * block-name-enum.test.ts unit-tests withBlockNameEnum directly;
 * add_module_to_page's path is also exercised live (scenario-ai-block-name).
 * move_module's toBlockName enum had only the helper-level unit coverage —
 * nothing pinned the actual moveModuleTool.describeSchema output, so a future
 * edit that dropped the describeSchema wiring (or pointed it at the wrong
 * arg) would regress AC#1's second tool unnoticed. This introspects the real
 * exported tool objects.
 */

import { describe, expect, it } from "bun:test";
import { addModuleToPageTool } from "../add-module-to-page.js";
import { buildToolDescribeState } from "../describe-state.js";
import { moveModuleTool } from "../move-module.js";

const ACTOR = { actorId: "00000000-0000-0000-0000-000000000001", actorKind: "ai" as const };

function stateWithBlocks(blockNames: readonly string[]) {
  return buildToolDescribeState({
    actor: ACTOR,
    layoutsValue: null,
    templatesValue: null,
    siteDefaultsValue: null,
    activePage: { id: "p1", templateId: "t1", blockNames },
  });
}

function enumOf(schema: Record<string, unknown>, arg: string): string[] | undefined {
  const props = schema.properties as Record<string, { enum?: string[] }>;
  return props[arg]?.enum;
}

describe("generation-time block enum is emitted by the real tool objects (AC#1)", () => {
  it("add_module_to_page.describeSchema pins blockName to the focused page's blocks", () => {
    const schema = addModuleToPageTool.describeSchema?.(stateWithBlocks(["content", "footer"]));
    expect(schema).toBeDefined();
    expect(enumOf(schema!, "blockName")).toEqual(["content", "footer"]);
  });

  it("move_module.describeSchema pins toBlockName to the focused page's blocks", () => {
    const schema = moveModuleTool.describeSchema?.(stateWithBlocks(["content", "footer"]));
    expect(schema).toBeDefined();
    expect(enumOf(schema!, "toBlockName")).toEqual(["content", "footer"]);
  });

  it("both fall back to a free-string (no enum) when there is no focused page", () => {
    const noPage = buildToolDescribeState({
      actor: ACTOR,
      layoutsValue: null,
      templatesValue: null,
      siteDefaultsValue: null,
      activePage: null,
    });
    expect(enumOf(addModuleToPageTool.describeSchema!(noPage), "blockName")).toBeUndefined();
    expect(enumOf(moveModuleTool.describeSchema!(noPage), "toBlockName")).toBeUndefined();
  });
});
