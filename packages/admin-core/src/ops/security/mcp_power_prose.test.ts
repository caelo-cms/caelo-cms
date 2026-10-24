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
import {
  isUntrustedToolResult,
  untrustedToolResult,
  untrustedToolResultValue,
} from "@caelo-cms/shared";
import { composeSystemPromptChunks, toolPlaybookBlock } from "../../ai/system-prompt.js";
import { createDefaultToolRegistry } from "../../ai/tools/index.js";
import {
  POWER_MCP_EXCLUDED_TOOLS,
  powerToolCatalogue,
  surfaceToolResultContent,
} from "./mcp_power.js";
import { findExcludedToolMentions, withUnavailableToolsNote } from "./mcp_power_prose.js";

// Synthetic names — the helper contract (word boundaries, backticks,
// idempotence) is independent of which tools are excluded today.
const FIXTURE = new Map([
  ["alpha_tool", "use beta_tool instead"],
  ["alpha_tools", "batch variant; unavailable here"],
]);

describe("withUnavailableToolsNote / findExcludedToolMentions", () => {
  it("keeps the text byte-for-byte and appends one note listing the mentioned tools (#1044)", () => {
    const text = "Call `alpha_tool` or alpha_tool now.";
    const out = withUnavailableToolsNote(text, FIXTURE);
    expect(out.startsWith(`${text} `)).toBe(true);
    expect(out).toBe(
      `${text} [Not available on this surface — this text names tools this connection does not serve; do not call them: \`alpha_tool\` (use beta_tool instead).]`,
    );
  });

  it("never puts a note right after a tool name", () => {
    const text = "Use `alpha_tool` here.\nThen alpha_tools for batches.";
    const out = withUnavailableToolsNote(text, FIXTURE);
    expect(out.slice(0, text.length)).toBe(text);
    // Multi-line text gets the note as its own paragraph, one tool per line.
    expect(out.slice(text.length)).toBe(
      "\n\n[Not available on this surface — this text names tools this connection does not serve; do not call them:\n" +
        "- `alpha_tool` (use beta_tool instead)\n" +
        "- `alpha_tools` (batch variant; unavailable here)]",
    );
  });

  it("never matches inside a longer tool name and is idempotent", () => {
    const once = withUnavailableToolsNote("Prefer alpha_tools for batches.", FIXTURE);
    expect(once).toContain("`alpha_tools` (batch variant; unavailable here)");
    expect(once).not.toContain("`alpha_tool` (");
    expect(withUnavailableToolsNote(once, FIXTURE)).toBe(once);
  });

  it("returns text without mentions unchanged", () => {
    expect(withUnavailableToolsNote("nothing here", FIXTURE)).toBe("nothing here");
  });

  it("reports only mentions the note does not cover", () => {
    expect(findExcludedToolMentions("run alpha_tool", FIXTURE.keys())).toEqual(["alpha_tool"]);
    const noted = withUnavailableToolsNote("run alpha_tool and alpha_tools", FIXTURE);
    expect(findExcludedToolMentions(noted, FIXTURE.keys())).toEqual([]);
    expect(findExcludedToolMentions("nothing here", FIXTURE.keys())).toEqual([]);
    // A note for one tool does not cover a mention of another.
    const notedForOne = withUnavailableToolsNote("run alpha_tool", FIXTURE);
    expect(findExcludedToolMentions(`alpha_tools, ${notedForOne}`, FIXTURE.keys())).toEqual([
      "alpha_tools",
    ]);
  });

  it("round-trips every entry of the LIVE exclusion map", () => {
    for (const name of POWER_MCP_EXCLUDED_TOOLS.keys()) {
      const text = `First call \`${name}\`, then ${name} again.`;
      expect(findExcludedToolMentions(text, POWER_MCP_EXCLUDED_TOOLS.keys())).toEqual([name]);
      const noted = withUnavailableToolsNote(text, POWER_MCP_EXCLUDED_TOOLS);
      expect(noted.startsWith(text)).toBe(true);
      expect(findExcludedToolMentions(noted, POWER_MCP_EXCLUDED_TOOLS.keys())).toEqual([]);
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
    expect(playbook?.body).toContain("`screenshot_page`");
    expect(playbook?.body).toContain("rendered server-side");
    expect(playbook?.body).toContain("`inspect_page_render`");
    // The chat-only tool-search deferral instruction must not leak here:
    // the MCP tool list already carries every schema.
    expect(playbook?.body).not.toContain("tool-search tool");
  });

  it("names inspect_built_page only on GCP installs, where it can run", () => {
    // e2e-livedit 2026-10: off GCP the tool failed with "only available on
    // GCP installs" every time the prompt steered the model to it.
    for (const surface of ["chat", "power-mcp"] as const) {
      expect(toolPlaybookBlock(surface, { CAELO_PROVIDER: "gcp" })).toContain(
        "`inspect_built_page`",
      );
      expect(toolPlaybookBlock(surface, { CAELO_PROVIDER: "gcp-firebase" })).toContain(
        "`inspect_built_page`",
      );
      expect(toolPlaybookBlock(surface, { CAELO_PROVIDER: "self-hosted" })).not.toContain(
        "inspect_built_page",
      );
      expect(toolPlaybookBlock(surface, {})).not.toContain("inspect_built_page");
    }
  });

  it("served catalogue descriptions carry no note inline after a tool name (#1044)", () => {
    for (const t of powerToolCatalogue(createDefaultToolRegistry())) {
      for (const name of POWER_MCP_EXCLUDED_TOOLS.keys()) {
        expect(`${t.name}: ${t.description}`).not.toMatch(
          new RegExp(`${name}\`?\\s*\\[not available on this surface`, "i"),
        );
      }
    }
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

describe("surfaceToolResultContent — data results round-trip (bug 2c323d9a)", () => {
  const names = [...POWER_MCP_EXCLUDED_TOOLS.keys()];
  const html = names.map((n) => `<p>Use <code>${n}</code> or \`${n}\` here.</p>`).join("");

  it("returns site-data tool results byte-for-byte, even when they name excluded tools", () => {
    // A docs page documenting the chat surface legitimately names these
    // tools; annotating the read let a read-modify-write persist the note.
    for (const tool of [
      "get_content_instance",
      "read_content",
      "query_page_html",
      "grep_content",
      "list_modules",
    ]) {
      const content = JSON.stringify({ values: { body: html } });
      expect(surfaceToolResultContent(tool, content)).toBe(content);
    }
  });

  it("passes a plugin result through still wrapped as untrusted data (#635)", () => {
    // The wrapper is applied before this boundary; dropping the annotation
    // must leave it intact and its value unchanged.
    const value = { comments: [{ content: html }] };
    const wrapped = untrustedToolResult(value);
    const served = surfaceToolResultContent("list_comments", wrapped);
    expect(served).toBe(wrapped);
    expect(isUntrustedToolResult(served)).toBe(true);
    expect(untrustedToolResultValue(served)).toEqual(value);
  });

  it("still annotates load_skill results, which are instruction prose", () => {
    const content = `Loaded skill "x" — X. Follow these instructions:\n\n${html}`;
    const served = surfaceToolResultContent("load_skill", content);
    // The skill text is served unchanged; the note follows it.
    expect(served.startsWith(content)).toBe(true);
    expect(served).toContain("[Not available on this surface — ");
    expect(findExcludedToolMentions(served, names)).toEqual([]);
  });
});
