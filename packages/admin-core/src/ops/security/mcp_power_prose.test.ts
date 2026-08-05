// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #413 — the prompt↔catalog consistency class, unit tier (no DB):
 * nothing the Power-MCP surface serves may RECOMMEND a tool that
 * POWER_MCP_EXCLUDED_TOOLS strips from its catalogue. Covered here: the
 * composed "power-mcp" prompt chunks and the served tool descriptions.
 * The DB-dependent half (skill bodies via mcp.get_context) lives in
 * __tests__/mcp-power.integration.test.ts.
 *
 * Every surface assertion derives its expectations from the LIVE
 * exclusion map — when #412 later removes screenshot_page from it, its
 * mentions stop being violations and these tests keep passing unchanged.
 */

import { describe, expect, it } from "bun:test";
import { composeSystemPromptChunks } from "../../ai/system-prompt.js";
import { createDefaultToolRegistry } from "../../ai/tools/index.js";
import { POWER_MCP_EXCLUDED_TOOLS, powerToolCatalogue } from "./mcp_power.js";
import { annotateExcludedToolMentions, findExcludedToolMentions } from "./mcp_power_prose.js";

// Synthetic names — the helper contract (word boundaries, backticks,
// idempotence) is independent of which tools are excluded today.
const FIXTURE = new Map([
  ["alpha_tool", "use beta_tool instead"],
  ["alpha_tools", "batch variant; unavailable here"],
]);

describe("annotateExcludedToolMentions / findExcludedToolMentions", () => {
  it("annotates backticked and bare mentions, placing the note outside inline code", () => {
    const out = annotateExcludedToolMentions("Call `alpha_tool` or alpha_tool now.", FIXTURE);
    expect(out).toBe(
      "Call `alpha_tool` [not available on this surface — use beta_tool instead] " +
        "or alpha_tool [not available on this surface — use beta_tool instead] now.",
    );
  });

  it("never matches inside a longer tool name and is idempotent", () => {
    const once = annotateExcludedToolMentions("Prefer alpha_tools for batches.", FIXTURE);
    expect(once).toBe(
      "Prefer alpha_tools [not available on this surface — batch variant; unavailable here] for batches.",
    );
    expect(annotateExcludedToolMentions(once, FIXTURE)).toBe(once);
  });

  it("reports only unannotated mentions", () => {
    expect(findExcludedToolMentions("run alpha_tool", FIXTURE.keys())).toEqual(["alpha_tool"]);
    const annotated = annotateExcludedToolMentions("run alpha_tool and alpha_tools", FIXTURE);
    expect(findExcludedToolMentions(annotated, FIXTURE.keys())).toEqual([]);
    expect(findExcludedToolMentions("nothing here", FIXTURE.keys())).toEqual([]);
  });

  it("round-trips every entry of the LIVE exclusion map", () => {
    for (const name of POWER_MCP_EXCLUDED_TOOLS.keys()) {
      const text = `First call \`${name}\`, then ${name} again.`;
      expect(findExcludedToolMentions(text, POWER_MCP_EXCLUDED_TOOLS.keys())).toEqual([name]);
      const annotated = annotateExcludedToolMentions(text, POWER_MCP_EXCLUDED_TOOLS);
      expect(findExcludedToolMentions(annotated, POWER_MCP_EXCLUDED_TOOLS.keys())).toEqual([]);
    }
  });
});

describe("Power-MCP prompt↔catalog consistency (#413)", () => {
  it("no composed power-mcp chunk recommends an excluded tool", () => {
    const chunks = composeSystemPromptChunks(
      [{ slot: "tone", body: "calm" }],
      { skillsIndexBlock: "# Skills\n- x: y" },
      "power-mcp",
    );
    const violations = chunks
      .map(
        (c) =>
          [c.label, findExcludedToolMentions(c.body, POWER_MCP_EXCLUDED_TOOLS.keys())] as const,
      )
      .filter(([, names]) => names.length > 0);
    expect(violations).toEqual([]);
  });

  it("power-mcp playbook names the working visual-inspection tools incl. server-side screenshot_page", () => {
    // Issue #413 acceptance criterion, updated by #412: screenshot_page is
    // no longer excluded on this surface — the playbook now serves it (the
    // server-side backend renders the session branch's preview), so the
    // clause routes to it directly instead of the old alternatives.
    const playbook = composeSystemPromptChunks([], {}, "power-mcp").find(
      (c) => c.label === "tool-playbook",
    );
    expect(playbook).toBeDefined();
    expect(playbook?.body).toContain("`inspect_built_page`");
    expect(playbook?.body).toContain("`screenshot_page`");
    expect(playbook?.body).toContain("rendered server-side");
    expect(playbook?.body).toContain("`inspect_page_render`");
    // The chat-only tool-search deferral instruction must not leak here:
    // the MCP tool list already carries every schema.
    expect(playbook?.body).not.toContain("tool-search tool");
  });

  it("served catalogue descriptions never recommend an excluded tool", () => {
    const violations = powerToolCatalogue(createDefaultToolRegistry())
      .map(
        (t) =>
          [
            t.name,
            findExcludedToolMentions(t.description, POWER_MCP_EXCLUDED_TOOLS.keys()),
          ] as const,
      )
      .filter(([, names]) => names.length > 0);
    expect(violations).toEqual([]);
  });
});
