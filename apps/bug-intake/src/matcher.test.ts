// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#906, #1049) — the semantic matcher merges only when the model
 * is sure AND names one of the offered clusters; any other answer opens a
 * new cluster, because a wrong merge hides a defect. The prompt carries each
 * candidate's tool and source as hints and stays bounded.
 */

import { describe, expect, it } from "bun:test";
import { BUG_INTAKE_LIMITS, type BugIntakeReport } from "@caelo-cms/shared";
import { MockLanguageModelV3 } from "ai/test";
import { LlmClusterMatcher, matchPrompt } from "./matcher.js";
import { CANDIDATE_TEXT_CHARS, type ClusterSummary, MAX_CANDIDATES } from "./store.js";

const report: BugIntakeReport = {
  protocolVersion: 1,
  reportId: "00000000-0000-4000-8000-000000000001",
  caeloVersion: "0.10.55",
  fingerprint: "a".repeat(64),
  source: "ai",
  kind: "defect",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: "screenshot_page",
  title: "screenshot ignores selector",
  whatHappened: "returned the full page",
  expected: "a crop",
  evidence: null,
};
const candidates: ClusterSummary[] = [
  {
    id: "c_1",
    kind: "defect",
    title: "Selector crop ignored",
    whatHappened: "full page instead of the element",
    suspectedTool: "screenshot_page (selector crop)",
    source: "ai",
  },
  {
    id: "c_2",
    kind: "defect",
    title: "Tool screenshot_page returned an error",
    whatHappened: "no image after 30s",
    suspectedTool: "screenshot_page",
    source: "auto",
  },
];

/** `suspectedTool` length cap of the report contract (packages/shared/src/bug-intake.ts). */
const MAX_TOOL_CHARS = 200;

function modelAnswering(answer: unknown) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(answer) }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

describe("LlmClusterMatcher", () => {
  it("accepts a high-confidence answer naming an offered cluster", async () => {
    const m = new LlmClusterMatcher(modelAnswering({ clusterId: "c_1", confidence: "high" }));
    expect(await m.match(report, candidates)).toBe("c_1");
  });

  it.each([
    ["medium confidence", { clusterId: "c_1", confidence: "medium" }],
    ["a cluster it was not offered", { clusterId: "c_9", confidence: "high" }],
    ["no match", { clusterId: null, confidence: "high" }],
  ])("opens a new cluster on %s", async (_label, answer) => {
    const m = new LlmClusterMatcher(modelAnswering(answer));
    expect(await m.match(report, candidates)).toBeNull();
  });

  it("does not call the model without candidates", async () => {
    const model = modelAnswering({ clusterId: "c_1", confidence: "high" });
    expect(await new LlmClusterMatcher(model).match(report, [])).toBeNull();
    expect(model.doGenerateCalls.length).toBe(0);
  });

  it("tells the model what the new report and every candidate say, tool and source included", () => {
    const p = matchPrompt(report, candidates);
    expect(p).toContain("screenshot ignores selector");
    expect(p).toContain('<candidate id="c_2">');
    expect(p).toContain("Tool: screenshot_page (selector crop)");
    expect(p).toContain("Source: captured automatically from a failing tool call");
    expect(p).toContain("Source: filed by the AI assistant");
    expect(p).toContain("may be named differently for the same defect");
    expect(p).toContain("When unsure, answer null.");
  });

  it("never names a cluster of the other kind, even when the model does (#1192)", async () => {
    const suggestion: BugIntakeReport = { ...report, kind: "suggestion", severity: null };
    const model = modelAnswering({ clusterId: "c_1", confidence: "high" });
    // Both offered candidates are defects: the model is not even asked.
    expect(await new LlmClusterMatcher(model).match(suggestion, candidates)).toBeNull();
    expect(model.doGenerateCalls.length).toBe(0);

    const mixed: ClusterSummary[] = [
      ...candidates,
      { ...candidates[0]!, id: "c_s1", kind: "suggestion", title: "No bulk view of pages" },
    ];
    const asked = modelAnswering({ clusterId: "c_1", confidence: "high" });
    expect(await new LlmClusterMatcher(asked).match(suggestion, mixed)).toBeNull();
    const prompt = JSON.stringify(asked.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('<candidate id=\\"c_s1\\">');
    expect(prompt).not.toContain('<candidate id=\\"c_1\\">');
  });

  it("asks about the same idea for a suggestion and the same defect for a defect", () => {
    const s = matchPrompt({ ...report, kind: "suggestion", severity: null }, candidates);
    expect(s).toContain("You triage suggestions about the Caelo CMS");
    expect(s).toContain("the same missing capability or the same missing documentation");
    expect(s).not.toContain("same underlying defect");
    expect(matchPrompt(report, candidates)).toContain("same underlying defect");
  });

  it("keeps the prompt bounded for a full pool of maximal candidates and a maximal report", () => {
    const big = (n: number) => "x".repeat(n);
    const worst: BugIntakeReport = {
      ...report,
      suspectedTool: big(MAX_TOOL_CHARS),
      title: big(BUG_INTAKE_LIMITS.title),
      whatHappened: big(BUG_INTAKE_LIMITS.whatHappened),
      expected: big(BUG_INTAKE_LIMITS.expected),
    };
    const pool: ClusterSummary[] = Array.from({ length: MAX_CANDIDATES }, (_, i) => ({
      id: `c_${String(i).padStart(20, "0")}`,
      kind: "defect",
      title: big(BUG_INTAKE_LIMITS.title),
      whatHappened: big(CANDIDATE_TEXT_CHARS),
      suspectedTool: big(MAX_TOOL_CHARS),
      source: "auto",
    }));
    // About 13k tokens at most: one cheap model call per new fingerprint.
    expect(matchPrompt(worst, pool).length).toBeLessThan(55_000);
  });
});
