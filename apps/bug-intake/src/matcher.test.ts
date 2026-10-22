// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#906) — the semantic matcher merges only when the model is
 * sure AND names one of the offered clusters; any other answer opens a new
 * cluster, because a wrong merge hides a defect.
 */

import { describe, expect, it } from "bun:test";
import type { BugIntakeReport } from "@caelo-cms/shared";
import { MockLanguageModelV3 } from "ai/test";
import { LlmClusterMatcher, matchPrompt } from "./matcher.js";

const report: BugIntakeReport = {
  protocolVersion: 1,
  reportId: "00000000-0000-4000-8000-000000000001",
  caeloVersion: "0.10.55",
  fingerprint: "a".repeat(64),
  source: "ai",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: "screenshot_page",
  title: "screenshot ignores selector",
  whatHappened: "returned the full page",
  expected: "a crop",
  evidence: null,
};
const candidates = [
  { id: "c_1", title: "Selector crop ignored", whatHappened: "full page instead of the element" },
  { id: "c_2", title: "Screenshot times out", whatHappened: "no image after 30s" },
];

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

  it("tells the model what the new report and every candidate say", () => {
    const p = matchPrompt(report, candidates);
    expect(p).toContain("screenshot ignores selector");
    expect(p).toContain('<candidate id="c_2">');
    expect(p).toContain("When unsure, answer null.");
  });
});
