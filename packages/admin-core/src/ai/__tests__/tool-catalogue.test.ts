// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for buildToolCatalogue — the tool-registration half of the
 * chat-runner split (issue #15). The core set is tagged `alwaysLoaded`,
 * everything else defers behind Tool Search, and only `excluded` (depth
 * cap) and `spawnAllowed` (per-spawn narrowing) remove tools. Nothing the
 * conversation did (loaded skills) shapes the result: the tool list is the
 * front of the provider's cached prefix. No DB needed.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { buildToolCatalogue } from "../chat-runner/tool-catalogue.js";
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

const chatSessionId = "11111111-1111-4111-8111-222222222222";

describe("buildToolCatalogue", () => {
  it("returns the full catalogue when nothing is excluded", () => {
    const tools = registry("update_modules_many", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
      excluded: undefined,
      chatSessionId,
    });
    expect(result.map((t) => t.name).sort()).toEqual([
      "add_module_to_page",
      "list_pages",
      "update_modules_many",
    ]);
  });

  it("run #9 R7: the child-session exclusion strips the spawn tools", () => {
    const tools = registry(
      "update_modules_many",
      "list_pages",
      "spawn_subagent",
      "spawn_subagents",
    );
    const result = buildToolCatalogue({
      tools,
      excluded: new Set(["spawn_subagent", "spawn_subagents"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name).sort()).toEqual(["list_pages", "update_modules_many"]);
  });

  it("child-session exclusion strips screenshot_page", () => {
    // A subagent has no operator browser, so spawn_subagent adds
    // screenshot_page to the child's excluded set — a HARD filter.
    // Guards the fix for the 14×-timeout / edit→screenshot→edit thrash.
    const tools = registry("update_modules_many", "inspect_page_render", "screenshot_page");
    const result = buildToolCatalogue({
      tools,
      excluded: new Set(["spawn_subagent", "spawn_subagents", "screenshot_page"]),
      chatSessionId,
    });
    const names = result.map((t) => t.name).sort();
    expect(names).toContain("inspect_page_render"); // server-side verify path survives
    expect(names).not.toContain("screenshot_page");
  });

  it("run #8 R2b: spawnAllowed remains a HARD filter for read tools too", () => {
    // A parent that explicitly narrows a review subagent to two read
    // tools gets exactly those.
    const tools = registry(
      "list_pages",
      "list_modules",
      "inspect_page_render",
      "update_modules_many",
    );
    const result = buildToolCatalogue({
      tools,
      excluded: undefined,
      spawnAllowed: new Set(["list_pages", "inspect_page_render"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name).sort()).toEqual(["inspect_page_render", "list_pages"]);
  });

  it("drops excluded tool names (the spawn-subagent depth cap)", () => {
    const tools = registry("update_modules_many", "spawn_subagent", "spawn_subagents");
    const result = buildToolCatalogue({
      tools,
      excluded: new Set(["spawn_subagent", "spawn_subagents"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["update_modules_many"]);
  });

  it("issue #264: spawnAllowed narrows the catalogue as a hard filter", () => {
    const tools = registry("update_modules_many", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
      excluded: undefined,
      spawnAllowed: new Set(["list_pages"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["list_pages"]);
  });

  it("issue #264: spawnAllowed gets NO zero-match fallback", () => {
    // The spawn handler validates the allowlist against live tool names
    // before the child turn starts, so a zero-match here is an upstream
    // bug — widening back to the full catalogue would silently grant
    // write tools to a subagent the parent asked to narrow.
    const tools = registry("update_modules_many", "add_module_to_page");
    const result = buildToolCatalogue({
      tools,
      excluded: undefined,
      spawnAllowed: new Set(["pages.list"]),
      chatSessionId,
    });
    expect(result).toEqual([]);
  });

  it("run #8 R5: logs loudly when a tool disappears between turns of the same session", () => {
    const tools = registry("update_modules_many", "list_modules", "add_module_to_page");
    const shrinkSessionId = "11111111-1111-4111-8111-333333333333";
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Turn 1: full catalogue.
      buildToolCatalogue({
        tools,
        excluded: undefined,
        chatSessionId: shrinkSessionId,
      });
      // Turn 2: add_module_to_page is excluded (a HARD filter — the only
      // thing that removes a tool now) and disappears.
      buildToolCatalogue({
        tools,
        excluded: new Set(["add_module_to_page"]),
        chatSessionId: shrinkSessionId,
      });
      const shrankCall = errSpy.mock.calls.find((c) =>
        String(c[0]).includes("tool-catalogue-shrank"),
      );
      expect(shrankCall).toBeDefined();
      expect((shrankCall![1] as { disappeared: string[] }).disappeared).toEqual([
        "add_module_to_page",
      ]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("issue #264: spawnAllowed composes with exclusion", () => {
    const tools = registry("update_modules_many", "list_pages", "spawn_subagent");
    const result = buildToolCatalogue({
      tools,
      excluded: new Set(["spawn_subagent"]),
      spawnAllowed: new Set(["list_pages", "spawn_subagent"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["list_pages"]);
  });

  // Tool Search default-on — core workflow tools carry alwaysLoaded so
  // the Anthropic transform keeps their full definitions in every
  // request; the long tail defers behind the search tool.
  it("tags core tools with alwaysLoaded and leaves the long tail untagged", () => {
    const tools = registry("update_modules_many", "build_page", "set_page_seo_many", "list_pages");
    const result = buildToolCatalogue({
      tools,
      excluded: undefined,
      chatSessionId,
    });
    const byName = new Map(result.map((t) => [t.name, t]));
    expect(byName.get("update_modules_many")?.alwaysLoaded).toBe(true);
    expect(byName.get("build_page")?.alwaysLoaded).toBe(true);
    expect(byName.get("list_pages")?.alwaysLoaded).toBe(true);
    // set_page_seo is deliberately long-tail: named in the playbook,
    // loaded on demand via tool search.
    expect(byName.get("set_page_seo_many")?.alwaysLoaded).toBeUndefined();
  });

  // e2e-livedit 2026-10-26: a skill loaded in one turn changed the next
  // turn's tool list (its allowlist was tagged `alwaysLoaded`), and the
  // provider re-cached the whole chat history at full price on every such
  // turn (100–170k tokens written each, 14–19 % of a run's cost). The tool
  // list is the front of the prompt prefix, so the builder takes nothing
  // the conversation shapes: the same registry and scoping give the same
  // bytes on every turn of a chat.
  it("gives byte-identical tool lists on every turn of a chat (prompt-cache prefix)", () => {
    const tools = registry("update_modules_many", "build_page", "set_page_seo_many", "list_pages");
    const turn1 = buildToolCatalogue({ tools, excluded: undefined, chatSessionId });
    const turn2 = buildToolCatalogue({ tools, excluded: undefined, chatSessionId });
    expect(JSON.stringify(turn2)).toBe(JSON.stringify(turn1));
  });
});

describe("CORE_TOOL_NAMES", () => {
  it("every core tool name matches a tool in the default registry (no drift)", async () => {
    const { CORE_TOOL_NAMES } = await import("../tools/core-tools.js");
    const { createDefaultToolRegistry } = await import("../tools/index.js");
    const live = new Set(
      createDefaultToolRegistry()
        .catalogue()
        .map((t) => t.name),
    );
    const dead = [...CORE_TOOL_NAMES].filter((n) => !live.has(n));
    expect(dead).toEqual([]);
  });
});

describe("static tool definitions (2026-07 prompt-cache guarantee)", () => {
  it("two fresh default registries produce byte-identical catalogues", async () => {
    // Tool definitions are part of Anthropic's prompt-cache prefix. Any
    // state read at registration or catalogue time (DB values, Date,
    // randomness) would produce differing bytes across turns and bust
    // the cache on every call — the describe()/describeSchema() class
    // of bug this suite guards against staying removed.
    const { createDefaultToolRegistry } = await import("../tools/index.js");
    const a = createDefaultToolRegistry().catalogue();
    const b = createDefaultToolRegistry().catalogue();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
