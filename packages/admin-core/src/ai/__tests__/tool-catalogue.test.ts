// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for buildToolCatalogue — the tool-registration half of the
 * chat-runner split (issue #15). Post-Tool-Search (2026-07), skill
 * allowlists are PRELOAD hints, not filters: entries still resolve via
 * the issue-#301 op→tool table and tag their tools `alwaysLoaded`, but
 * NOTHING is removed from the catalogue — the model reaches everything
 * else via Tool Search. Only `excluded` (depth cap) and `spawnAllowed`
 * (per-spawn narrowing) hard-remove tools. No DB needed.
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
  it("returns the full catalogue when no allowlist and no exclusions", () => {
    const tools = registry("edit_module", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
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

  it("issue #301: op-notation entries translate to tool names and PRELOAD them (run #15 regression)", () => {
    // op-notation read allowlist. Post-Tool-Search, allowlists are
    // PRELOAD hints, not filters: the entries translate
    // (structured_sets.list → list_structured_sets, pages.list →
    // list_pages) and those tools get `alwaysLoaded` so the model reaches
    // them without a search round-trip. Nothing is removed — every other
    // tool stays reachable via Tool Search.
    const tools = registry(
      "edit_module",
      "add_module_to_page",
      "list_structured_sets",
      "list_pages",
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = buildToolCatalogue({
        tools,
        allowedToolNames: new Set(["structured_sets.list", "pages.list"]),
        engagedSkills: [],
        excluded: undefined,
        chatSessionId,
      });
      // Nothing dropped — the whole catalogue is present.
      expect(result.map((t) => t.name).sort()).toEqual(
        ["add_module_to_page", "edit_module", "list_structured_sets", "list_pages"].sort(),
      );
      // The resolved allowlist entry (list_structured_sets, not in the
      // core set) is preloaded via the skill hint.
      const loaded = new Set(result.filter((t) => t.alwaysLoaded).map((t) => t.name));
      expect(loaded.has("list_structured_sets")).toBe(true);
      // A clean resolution logs nothing.
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("skill-allowlist"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("issue #301: an all-garbage allowlist strands nobody — full catalogue, entries logged, nothing preloaded from it", () => {
    const tools = registry("edit_module", "add_module_to_page");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = buildToolCatalogue({
        tools,
        // Garbage that neither matches a live tool nor the translation table.
        allowedToolNames: new Set(["pages.frobnicate", "totally.bogus_op"]),
        engagedSkills: [],
        excluded: undefined,
        chatSessionId,
      });
      // The full catalogue is always present (allowlists never remove).
      expect(result.map((t) => t.name).sort()).toEqual(["add_module_to_page", "edit_module"]);
      // Each unresolved entry is still logged so a typo'd skill row is visible.
      const unresolvedCalls = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes("skill-allowlist-unresolved-entry"),
      );
      expect(unresolvedCalls.length).toBe(2);
      // No defect event exists anymore — narrowing is gone, so zero
      // resolution is not a failure mode.
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("skill-allowlist-defect"))).toBe(
        false,
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("issue #301: a partial resolution preloads the resolved subset and logs each unresolved entry with a suggestion", () => {
    const tools = registry("edit_module", "add_module_to_page", "list_pages");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = buildToolCatalogue({
        tools,
        allowedToolNames: new Set(["edit_modul", "add_module_to_page"]),
        engagedSkills: [],
        excluded: undefined,
        chatSessionId,
      });
      // Nothing dropped; the resolved non-core write is preloaded.
      expect(result.map((t) => t.name).sort()).toEqual([
        "add_module_to_page",
        "edit_module",
        "list_pages",
      ]);
      expect(result.find((t) => t.name === "add_module_to_page")?.alwaysLoaded).toBe(true);
      const unresolvedCall = errSpy.mock.calls.find((c) =>
        String(c[0]).includes("skill-allowlist-unresolved-entry"),
      );
      expect(unresolvedCall).toBeDefined();
      const payload = unresolvedCall?.[1] as { entry: string; suggestion: string | null };
      expect(payload.entry).toBe("edit_modul");
      expect(payload.suggestion).toBe("edit_module");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a non-empty allowlist never removes writes — they stay reachable, only preload differs (run #8 R2b/R5)", () => {
    const tools = registry("edit_module", "add_module_to_page", "list_pages");
    const result = buildToolCatalogue({
      tools,
      allowedToolNames: new Set(["edit_module", "not_a_real_tool"]),
      engagedSkills: [],
      excluded: undefined,
      chatSessionId,
    });
    // add_module_to_page (write, not allowlisted) is NOT dropped anymore —
    // it stays in the catalogue (reachable via search), just not preloaded.
    expect(result.map((t) => t.name).sort()).toEqual([
      "add_module_to_page",
      "edit_module",
      "list_pages",
    ]);
    expect(result.find((t) => t.name === "add_module_to_page")?.alwaysLoaded).toBeUndefined();
  });

  it("run #8 R2b: a rebuild subagent keeps its lookup/inspect tools when a skill allowlist engages", () => {
    // The live compose-page allowlist (migration 0088) — write-focused,
    // with NO lookup tools. In run #8 the rebuild subagent's seed
    // message engaged this skill and the subagent lost
    // inspect_page_render + module lookup, then edited a wrong module.
    const composePageAllowlist = new Set([
      "build_page",
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
      allowedToolNames: composePageAllowlist,
      engagedSkills: [],
      excluded: new Set(["spawn_subagent", "spawn_subagents"]),
      chatSessionId,
    });
    // Post-Tool-Search: the allowlist removes NOTHING, so the rebuild
    // subagent keeps every lookup/inspect tool AND the write the skill
    // forgot to list (delete_page) — that write is now reachable, just
    // not preloaded. Only the excluded spawn tools drop.
    expect(result.map((t) => t.name).sort()).toEqual([
      "delete_page",
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

  it("run #9 R7: an orchestrator keeps spawn_subagent when a co-engaged skill allowlist narrows writes", () => {
    // The migration run #9 shape: site-migrate (allowlist []) engages
    // together with compose-page (write allowlist, predates the 0132
    // subagent contract → no spawn tools listed). The ORCHESTRATOR
    // session has no `excluded` set — only subagent children do — so
    // the spawn tools must survive the skill-allowlist narrowing the
    // same way read tools do, or the skill body says "spawn subagents"
    // while the catalogue says "no such tool".
    const composePageAllowlist = new Set([
      "build_page",
      "create_page",
      "add_module_to_page",
      "edit_module",
      "set_page_module_content",
    ]);
    const tools = registry(
      "edit_module",
      "create_page",
      "delete_page", // write outside the allowlist — must drop
      "list_pages", // read — immune
      "spawn_subagent",
      "spawn_subagents",
    );
    const result = buildToolCatalogue({
      tools,
      allowedToolNames: composePageAllowlist,
      engagedSkills: [],
      excluded: undefined,
      chatSessionId,
    });
    // Nothing is narrowed anymore, so the orchestrator keeps its spawn
    // tools (and delete_page, the write outside the allowlist) — the
    // whole catalogue is present.
    expect(result.map((t) => t.name).sort()).toEqual([
      "create_page",
      "delete_page",
      "edit_module",
      "list_pages",
      "spawn_subagent",
      "spawn_subagents",
    ]);
  });

  it("run #9 R7: the child-session exclusion still strips spawn tools despite the immunity", () => {
    const tools = registry("edit_module", "list_pages", "spawn_subagent", "spawn_subagents");
    const result = buildToolCatalogue({
      tools,
      allowedToolNames: new Set(["edit_module"]),
      engagedSkills: [],
      excluded: new Set(["spawn_subagent", "spawn_subagents"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name).sort()).toEqual(["edit_module", "list_pages"]);
  });

  it("child-session exclusion strips screenshot_page despite its read-only-name immunity", () => {
    // screenshot_page matches the read-only naming convention (screenshot_),
    // so the skill-allowlist narrowing never drops it. But a subagent has no
    // operator browser, so spawn_subagent adds it to the child's excluded set
    // — and `excluded` is a HARD filter that overrides the read immunity.
    // Guards the fix for the 14×-timeout / edit→screenshot→edit thrash.
    const tools = registry("edit_module", "inspect_page_render", "screenshot_page");
    const result = buildToolCatalogue({
      tools,
      allowedToolNames: new Set(["edit_module"]),
      engagedSkills: [],
      excluded: new Set(["spawn_subagent", "spawn_subagents", "screenshot_page"]),
      chatSessionId,
    });
    const names = result.map((t) => t.name).sort();
    expect(names).toContain("inspect_page_render"); // server-side verify path survives
    expect(names).not.toContain("screenshot_page");
  });

  it("run #8 R2b: spawnAllowed remains a HARD filter for read tools too", () => {
    // A parent that explicitly narrows a review subagent to two read
    // tools gets exactly those — the read-immunity applies to SKILL
    // allowlists only, never to explicit per-spawn narrowing.
    const tools = registry("list_pages", "list_modules", "inspect_page_render", "edit_module");
    const result = buildToolCatalogue({
      tools,
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
        allowedToolNames: null,
        engagedSkills: [],
        excluded: undefined,
        chatSessionId: shrinkSessionId,
      });
      // Turn 2: add_module_to_page is excluded (a HARD filter — the only
      // thing that removes a tool now) and disappears.
      buildToolCatalogue({
        tools,
        allowedToolNames: null,
        engagedSkills: [],
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

  it("issue #264: spawnAllowed composes with exclusion and the skill allowlist", () => {
    const tools = registry("edit_module", "list_pages", "spawn_subagent");
    const result = buildToolCatalogue({
      tools,
      allowedToolNames: new Set(["edit_module", "list_pages", "spawn_subagent"]),
      engagedSkills: [],
      excluded: new Set(["spawn_subagent"]),
      spawnAllowed: new Set(["list_pages", "spawn_subagent"]),
      chatSessionId,
    });
    expect(result.map((t) => t.name)).toEqual(["list_pages"]);
  });

  // Tool Search (2026-07 live-edit) — the search-storm fix. A skill
  // allowlist that omits core writes must not leave them un-preloaded;
  // otherwise the model burns a tool-search storm hunting for a core
  // write (create_content_instance / remove_module_from fired 11
  // back-to-back searches in one nested-CTA turn). Core writes are
  // always preloaded regardless of the allowlist; nothing is dropped.
  it("always preloads CORE write tools even when a skill allowlist omits them", () => {
    const tools = registry(
      "edit_module",
      "create_content_instance", // core write, NOT in the allowlist below
      "remove_module_from", // core write, NOT in the allowlist below
      "autofill_page_seo", // non-core write, NOT allowlisted
      "list_pages",
    );
    const result = buildToolCatalogue({
      tools,
      allowedToolNames: new Set(["edit_module"]),
      engagedSkills: [],
      excluded: undefined,
      chatSessionId,
    });
    const loaded = new Set(result.filter((t) => t.alwaysLoaded).map((t) => t.name));
    // Every core tool is preloaded (schema up front) — no search needed.
    expect(loaded.has("create_content_instance")).toBe(true);
    expect(loaded.has("remove_module_from")).toBe(true);
    expect(loaded.has("edit_module")).toBe(true);
    expect(loaded.has("list_pages")).toBe(true);
    // The non-core write stays in the catalogue (reachable via search)
    // but is NOT preloaded.
    const names = new Set(result.map((t) => t.name));
    expect(names.has("autofill_page_seo")).toBe(true);
    expect(loaded.has("autofill_page_seo")).toBe(false);
  });

  // Tool Search default-on — core workflow tools carry alwaysLoaded so
  // the Anthropic transform keeps their full definitions in every
  // request; the long tail defers behind the search tool.
  it("tags core tools with alwaysLoaded and leaves the long tail untagged", () => {
    const tools = registry("edit_module", "build_page", "set_page_seo", "list_pages");
    const result = buildToolCatalogue({
      tools,
      allowedToolNames: null,
      engagedSkills: [],
      excluded: undefined,
      chatSessionId,
    });
    const byName = new Map(result.map((t) => [t.name, t]));
    expect(byName.get("edit_module")?.alwaysLoaded).toBe(true);
    expect(byName.get("build_page")?.alwaysLoaded).toBe(true);
    expect(byName.get("list_pages")?.alwaysLoaded).toBe(true);
    // set_page_seo is deliberately long-tail: named in the playbook,
    // loaded on demand via tool search.
    expect(byName.get("set_page_seo")?.alwaysLoaded).toBeUndefined();
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
