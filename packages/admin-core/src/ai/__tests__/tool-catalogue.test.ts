// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for buildToolCatalogue — the tool-registration half of the
 * chat-runner split (issue #15). Locks in the issue-#106 root-cause guard
 * (a skill allowlist that matches ZERO live tools must fall back to the full
 * catalogue, never strand the AI with zero tools), plus the allowlist
 * narrowing and the subagent-exclusion paths. No DB needed.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { buildToolCatalogue } from "../chat-runner/tool-catalogue.js";
import { buildToolDescribeState } from "../tools/describe-state.js";
import { type ToolDefinitionWithHandler, ToolRegistry } from "../tools/dispatch.js";

function fakeTool(name: string): ToolDefinitionWithHandler<Record<string, never>> {
  return {
    name,
    description: `fake ${name}`,
    schema: z.object({}).strict(),
    inputSchema: { type: "object" },
    handler: async () => ({ ok: true, content: "ok" }),
  };
}

function registry(...names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) r.register(fakeTool(n));
  return r;
}

// Tools have no describe()/describeSchema(), so the state is never read;
// build a valid one anyway from null op-values to mirror the real call.
const state = buildToolDescribeState({
  actor: { actorId: "11111111-1111-4111-8111-aaaaaaaaaaaa", actorKind: "ai" },
  layoutsValue: null,
  templatesValue: null,
  siteDefaultsValue: null,
  activePage: null,
});

const chatSessionId = "11111111-1111-4111-8111-222222222222";

describe("buildToolCatalogue", () => {
  it("returns the full catalogue when no allowlist and no exclusions", () => {
    const tools = registry("edit_module", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: null,
      engagedSkills: [],
      excluded: undefined,
      chatSessionId,
    });
    expect(result.map((t) => t.name).sort()).toEqual([
      "add_module_to_page",
      "edit_module",
      "list_pages",
    ]);
  });

  it("issue #106: a zero-match allowlist is treated as absent → full catalogue + loud warn", () => {
    const tools = registry("edit_module", "add_module_to_page");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = buildToolCatalogue({
        tools,
        toolDescribeState: state,
        // Op-style names that match no live AI tool name (the menu-auditor bug).
        allowedToolNames: new Set(["structured_sets.list", "pages.list"]),
        engagedSkills: [],
        excluded: undefined,
        chatSessionId,
      });
      // The AI is NOT stranded: it gets the whole catalogue back.
      expect(result.map((t) => t.name).sort()).toEqual(["add_module_to_page", "edit_module"]);
      // And the misconfiguration is logged loudly so the skill data gets fixed.
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("skill-allowlist-zero-match")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("narrows to the allowlist when it matches at least one live tool", () => {
    const tools = registry("edit_module", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: new Set(["edit_module", "not_a_real_tool"]),
      engagedSkills: [],
      excluded: undefined,
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["edit_module"]);
  });

  it("drops excluded tool names (the spawn-subagent depth cap)", () => {
    const tools = registry("edit_module", "spawn_subagent", "spawn_subagents");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: null,
      engagedSkills: [],
      excluded: new Set(["spawn_subagent", "spawn_subagents"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["edit_module"]);
  });

  it("allowlist and exclusion compose (exclusion still wins inside an allowlist)", () => {
    const tools = registry("edit_module", "add_module_to_page");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: new Set(["edit_module", "add_module_to_page"]),
      engagedSkills: [],
      excluded: new Set(["add_module_to_page"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["edit_module"]);
  });
});
