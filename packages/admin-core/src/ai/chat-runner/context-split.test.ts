// SPDX-License-Identifier: MPL-2.0

/**
 * issue #300 part A — unit tests for the context-split telemetry
 * splitter on fixture strings: chunk-label categorisation, per-skill
 * section splitting, tool-schema accounting, and the chars/4 math.
 */

import { describe, expect, it } from "bun:test";

import type { ChatMessageInput, SystemPromptChunk, ToolDefinition } from "../provider.js";
import { buildContextSplitEstimate, splitSkillsBlockChars } from "./context-split.js";

const est = (s: string): number => Math.ceil(s.length / 4);

function chunk(label: string, body: string, cacheable = false): SystemPromptChunk {
  return { label, body, cacheable };
}

describe("splitSkillsBlockChars", () => {
  it("splits the skills chunk into per-slug char counts with a (shared) preamble", () => {
    const body = [
      "# Engaged skills",
      "",
      "## Skill: site-migrate (auto — keyword match)",
      "Crawl the source site, then rebuild page by page.",
      "Line two of the body.",
      "",
      "## Skill: compose-page (pinned)",
      "One build_page call per page.",
    ].join("\n");
    const split = splitSkillsBlockChars(body);

    expect(Object.keys(split).sort()).toEqual(["(shared)", "compose-page", "site-migrate"]);
    // Every char of the block is attributed exactly once (± the final
    // newline rounding artifact documented in the splitter).
    const attributed = Object.values(split).reduce((a, b) => a + b, 0);
    expect(attributed).toBe(body.length + 1);
    // The bigger body got the bigger count.
    expect(split["site-migrate"]!).toBeGreaterThan(split["compose-page"]!);
    // Preamble is just the "# Engaged skills" header + blank line.
    expect(split["(shared)"]).toBe("# Engaged skills\n\n".length);
  });

  it("attributes everything to (shared) when no skill headers exist", () => {
    const split = splitSkillsBlockChars("free-form text without headers");
    expect(Object.keys(split)).toEqual(["(shared)"]);
  });
});

describe("buildContextSplitEstimate", () => {
  const base = chunk("base", "B".repeat(400), true);
  const moduleModel = chunk("module-model", "M".repeat(800), true);
  const staging = chunk("staging", "S".repeat(200), true);
  const memory = chunk("memory", "R".repeat(100), true);
  const toolsChunk = chunk("tools", "T".repeat(1200), true);
  const theme = chunk("theme", "H".repeat(2000));
  const allPages = chunk("all-pages", "P".repeat(4000));
  const skills = chunk(
    "skills",
    `# Engaged skills\n\n## Skill: site-migrate (auto)\n${"K".repeat(9000)}`,
  );
  const providerTools: ToolDefinition[] = [
    {
      name: "build_page",
      description: "Build one page in a single call.",
      inputSchema: { type: "object", properties: { slug: { type: "string" } } },
    },
  ];
  const messages: ChatMessageInput[] = [
    { role: "user", content: "U".repeat(400) },
    { role: "assistant", content: "A".repeat(100) },
  ];

  it("splits chunks by category, tools into the catalogue, skills per slug", () => {
    const split = buildContextSplitEstimate({
      systemChunks: [base, moduleModel, staging, memory, toolsChunk, theme, allPages, skills],
      providerTools,
      messages,
    });

    expect(split.estimator).toBe("chars/4");
    // Core prose backbone = base + module-model + staging + memory.
    expect(split.systemPromptTokens).toBe(
      est(base.body) + est(moduleModel.body) + est(staging.body) + est(memory.body),
    );
    // Catalogue = in-prompt tools chunk + provider-tools JSON schemas.
    expect(split.toolCatalogueTokens).toBe(
      est(toolsChunk.body) + est(JSON.stringify(providerTools)),
    );
    // Domain blocks keyed by chunk label.
    expect(split.contextBlockTokens).toEqual({
      theme: est(theme.body),
      "all-pages": est(allPages.body),
    });
    // Skills split per slug; the big body dominates.
    expect(split.skillTokens["site-migrate"]!).toBeGreaterThanOrEqual(9000 / 4);
    expect(split.skillTokens["(shared)"]).toBeDefined();
    // History via the message estimator (500 chars → 125 tokens).
    expect(split.historyTokens).toBe(125);
    expect(split.historyMessages).toBe(2);
    // Total is the sum of every component.
    const sum =
      split.systemPromptTokens +
      split.toolCatalogueTokens +
      Object.values(split.contextBlockTokens).reduce((a, b) => a + b, 0) +
      Object.values(split.skillTokens).reduce((a, b) => a + b, 0) +
      split.historyTokens;
    expect(split.totalTokens).toBe(sum);
  });

  it("attributes a legacy flat-string system prompt entirely to systemPromptTokens", () => {
    const split = buildContextSplitEstimate({
      systemChunks: "flat legacy prompt",
      providerTools: [],
      messages: [],
    });
    expect(split.systemPromptTokens).toBe(est("flat legacy prompt"));
    expect(split.toolCatalogueTokens).toBe(0);
    expect(split.contextBlockTokens).toEqual({});
    expect(split.skillTokens).toEqual({});
    expect(split.historyTokens).toBe(0);
  });
});
