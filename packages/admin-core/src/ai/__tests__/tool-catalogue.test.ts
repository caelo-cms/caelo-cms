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

  it("narrows WRITE tools to the allowlist; read tools always pass (run #8 R2b/R5)", () => {
    const tools = registry("edit_module", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: new Set(["edit_module", "not_a_real_tool"]),
      engagedSkills: [],
      excluded: undefined,
      chatSessionId,
    });
    // add_module_to_page (write, not allowlisted) drops; list_pages
    // (read-only) survives the narrowing.
    expect(result.map((t) => t.name).sort()).toEqual(["edit_module", "list_pages"]);
  });

  it("run #8 R2b: a rebuild subagent keeps its lookup/inspect tools when a skill allowlist engages", () => {
    // The live compose-page allowlist (migration 0088) — write-focused,
    // with NO lookup tools. In run #8 the rebuild subagent's seed
    // message engaged this skill and the subagent lost
    // inspect_page_render + module lookup, then edited a wrong module.
    const composePageAllowlist = new Set([
      "compose_page_from_spec",
      "create_page",
      "add_module_to_page",
      "edit_module",
      "set_page_module_content",
      "set_page_seo",
    ]);
    const tools = registry(
      // Rebuild-critical reads the brief tells the subagent to use.
      "inspect_page_render",
      "list_modules",
      "list_content_instances",
      "get_content_instance",
      "get_import_page_screenshot",
      "get_import_run_report",
      // Rebuild-critical writes (in the allowlist).
      "edit_module",
      "set_page_module_content",
      // A write outside the allowlist — must drop.
      "delete_page",
      // Spawn tools — excluded for the child (depth cap).
      "spawn_subagent",
      "spawn_subagents",
    );
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: composePageAllowlist,
      engagedSkills: [],
      excluded: new Set(["spawn_subagent", "spawn_subagents"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name).sort()).toEqual([
      "edit_module",
      "get_content_instance",
      "get_import_page_screenshot",
      "get_import_run_report",
      "inspect_page_render",
      "list_content_instances",
      "list_modules",
      "set_page_module_content",
    ]);
  });

  it("run #8 R2b: spawnAllowed remains a HARD filter for read tools too", () => {
    // A parent that explicitly narrows a review subagent to two read
    // tools gets exactly those — the read-immunity applies to SKILL
    // allowlists only, never to explicit per-spawn narrowing.
    const tools = registry("list_pages", "list_modules", "inspect_page_render", "edit_module");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: null,
      engagedSkills: [],
      excluded: undefined,
      spawnAllowed: new Set(["list_pages", "inspect_page_render"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name).sort()).toEqual(["inspect_page_render", "list_pages"]);
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

  it("issue #264: spawnAllowed narrows the catalogue as a hard filter", () => {
    const tools = registry("edit_module", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: null,
      engagedSkills: [],
      excluded: undefined,
      spawnAllowed: new Set(["list_pages"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["list_pages"]);
  });

  it("issue #264: spawnAllowed gets NO zero-match fallback (unlike the skill allowlist)", () => {
    // The spawn handler validates the allowlist against live tool names
    // before the child turn starts, so a zero-match here is an upstream
    // bug — widening back to the full catalogue would silently grant
    // write tools to a subagent the parent asked to narrow.
    const tools = registry("edit_module", "add_module_to_page");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: null,
      engagedSkills: [],
      excluded: undefined,
      spawnAllowed: new Set(["pages.list"]),
      chatSessionId,
    });
    expect(result).toEqual([]);
  });

  it("run #8 R5: logs loudly when a tool disappears between turns of the same session", () => {
    const tools = registry("edit_module", "list_modules", "add_module_to_page");
    const shrinkSessionId = "11111111-1111-4111-8111-333333333333";
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Turn 1: full catalogue.
      buildToolCatalogue({
        tools,
        toolDescribeState: state,
        allowedToolNames: null,
        engagedSkills: [],
        excluded: undefined,
        chatSessionId: shrinkSessionId,
      });
      // Turn 2: a skill allowlist engages and add_module_to_page drops.
      buildToolCatalogue({
        tools,
        toolDescribeState: state,
        allowedToolNames: new Set(["edit_module"]),
        engagedSkills: [],
        excluded: undefined,
        chatSessionId: shrinkSessionId,
      });
      const shrankCall = errSpy.mock.calls.find((c) =>
        String(c[0]).includes("tool-catalogue-shrank"),
      );
      expect(shrankCall).toBeDefined();
      expect((shrankCall?.[1] as { disappeared: string[] }).disappeared).toEqual([
        "add_module_to_page",
      ]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("issue #264: spawnAllowed composes with exclusion and the skill allowlist", () => {
    const tools = registry("edit_module", "list_pages", "spawn_subagent");
    const result = buildToolCatalogue({
      tools,
      toolDescribeState: state,
      allowedToolNames: new Set(["edit_module", "list_pages", "spawn_subagent"]),
      engagedSkills: [],
      excluded: new Set(["spawn_subagent"]),
      spawnAllowed: new Set(["list_pages", "spawn_subagent"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["list_pages"]);
  });
});
