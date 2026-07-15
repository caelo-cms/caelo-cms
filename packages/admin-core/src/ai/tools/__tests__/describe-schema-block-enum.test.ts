// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (AC#1 hardening) — assert the generation-time blockName enum is
 * actually emitted by the tool that carries it (`move_module`), not just by
 * the shared withBlockNameEnum helper in the abstract.
 *
 * block-name-enum.test.ts unit-tests withBlockNameEnum directly. `move_module`
 * had only helper-level unit coverage — nothing pinned the actual
 * moveModuleTool.describeSchema output, so a future edit that dropped the
 * describeSchema wiring (or pointed it at the wrong arg) would regress AC#1
 * unnoticed. This introspects the real exported tool object.
 *
 * NOTE (audit #2): the former `add_module_to_page` also pinned `blockName` at
 * generation time. Its successor `add_module` routes by `target` (page/layout/
 * template), so the block set isn't known until the target is chosen — the tool
 * therefore surfaces each target's blocks in its `describe()` prose instead of a
 * generation-time enum. `move_module` remains the single-target consumer of the
 * enum mechanism and keeps this coverage.
 */

import { describe, expect, it } from "bun:test";
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

describe("generation-time block enum is emitted by the real tool object (AC#1)", () => {
  it("move_module.describeSchema pins toBlockName to the focused page's blocks", () => {
    const schema = moveModuleTool.describeSchema?.(stateWithBlocks(["content", "footer"]));
    expect(schema).toBeDefined();
    expect(enumOf(schema!, "toBlockName")).toEqual(["content", "footer"]);
  });

  it("falls back to a free-string (no enum) when there is no focused page", () => {
    const noPage = buildToolDescribeState({
      actor: ACTOR,
      layoutsValue: null,
      templatesValue: null,
      siteDefaultsValue: null,
      activePage: null,
    });
    expect(enumOf(moveModuleTool.describeSchema!(noPage), "toBlockName")).toBeUndefined();
  });
});
