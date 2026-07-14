// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { buildReport, formatCostSection, parseAiCost } from "./build-stats.js";

const FULL = JSON.stringify({
  totalMicrocents: 150_000_000, // $1.50
  calls: 12,
  inputTokens: 340_000,
  outputTokens: 5_400,
  cachedTokens: 120_000,
  unpricedCalls: 0,
  byModel: [
    { model: "claude-opus-4-7", calls: 8, microcents: 140_000_000 },
    { model: "claude-sonnet-5", calls: 4, microcents: 10_000_000 },
  ],
});

const SUBCENT = JSON.stringify({
  totalMicrocents: 420_000, // $0.0042
  calls: 3,
  inputTokens: 1200,
  outputTokens: 90,
  cachedTokens: 0,
  unpricedCalls: 0,
  byModel: [{ model: "claude-haiku-5", calls: 3, microcents: 420_000 }],
});

const UNPRICED = JSON.stringify({
  totalMicrocents: 500_000,
  calls: 5,
  inputTokens: 9000,
  outputTokens: 400,
  cachedTokens: 0,
  unpricedCalls: 2,
  byModel: [{ model: "claude-opus-4-7", calls: 5, microcents: 500_000 }],
});

describe("parseAiCost", () => {
  it("parses a well-formed aggregate", () => {
    const c = parseAiCost(FULL);
    expect(c).not.toBeNull();
    expect(c?.totalMicrocents).toBe(150_000_000);
    expect(c?.calls).toBe(12);
    expect(c?.byModel).toHaveLength(2);
    expect(c?.byModel[0]?.model).toBe("claude-opus-4-7");
  });

  it("coerces string-encoded numeric columns (psql -A json output)", () => {
    // Postgres json_build_object over bigint SUMs can serialize as numbers,
    // but be defensive if a driver stringifies them.
    const c = parseAiCost(
      JSON.stringify({
        totalMicrocents: "150000000",
        calls: "12",
        inputTokens: "1",
        outputTokens: "2",
        cachedTokens: "3",
        unpricedCalls: "0",
        byModel: [{ model: "m", calls: "8", microcents: "1" }],
      }),
    );
    expect(c?.totalMicrocents).toBe(150_000_000);
    expect(c?.byModel[0]?.calls).toBe(8);
  });

  it("returns null for a missing file (empty string)", () => {
    expect(parseAiCost("")).toBeNull();
    expect(parseAiCost("   \n ")).toBeNull();
  });

  it("returns null for the {} capture-failure fallback (no calls key)", () => {
    expect(parseAiCost("{}")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseAiCost("not json at all")).toBeNull();
    expect(parseAiCost("{ broken")).toBeNull();
  });

  it("salvages JSON behind a stray psql command tag", () => {
    // Defends against a `SET`\n line leaking in front of the SELECT output.
    const c = parseAiCost(`SET\n${FULL}`);
    expect(c).not.toBeNull();
    expect(c?.calls).toBe(12);
  });

  it("tolerates a missing byModel array", () => {
    const c = parseAiCost(JSON.stringify({ calls: 1, totalMicrocents: 100 }));
    expect(c?.byModel).toEqual([]);
    expect(c?.unpricedCalls).toBe(0);
  });
});

describe("formatCostSection", () => {
  it("omits the section entirely when cost is null", () => {
    expect(formatCostSection(null)).toEqual([]);
  });

  it("renders total, calls, tokens, and a per-model table", () => {
    const md = formatCostSection(parseAiCost(FULL)).join("\n");
    expect(md).toContain("### Real AI cost (this run)");
    expect(md).toContain("$1.50");
    expect(md).toContain("**12** calls");
    expect(md).toContain("| Model | Calls | Cost |");
    expect(md).toContain("`claude-opus-4-7`");
    expect(md).not.toContain("unpriced");
  });

  it("shows extra precision for sub-cent totals", () => {
    const md = formatCostSection(parseAiCost(SUBCENT)).join("\n");
    expect(md).toContain("$0.0042");
  });

  it("renders a bold WARNING when unpricedCalls > 0", () => {
    const md = formatCostSection(parseAiCost(UNPRICED)).join("\n");
    expect(md).toContain("⚠️ 2 call(s) unpriced");
    expect(md).toContain("/security/ai");
    expect(md).toContain("real cost is HIGHER");
  });
});

describe("buildReport integration", () => {
  const REPORT = JSON.stringify({
    stats: { duration: 1000 },
    suites: [
      {
        specs: [
          { title: "scenario x", tests: [{ results: [{ status: "passed", duration: 500 }] }] },
        ],
      },
    ],
  });

  it("leads with the cost section and drops loop-log tokens when cost is present", () => {
    const log =
      '[chat-runner] enter {\n[chat-runner] loop {\n  chatSessionId: "s",\n  loop: 1,\n  loopStop: "end_turn",\n  toolCalls: 2,\n  textChars: 1,\n  thinkingBlocks: 0,\n  tokensIn: 1000,\n  tokensOut: 50,\n}';
    const md = buildReport({ log, reportRaw: REPORT, aiCostRaw: FULL });
    expect(md.indexOf("Real AI cost")).toBeLessThan(md.indexOf("Chat-runner API stats"));
    expect(md).toContain("see **Real AI cost** above");
    // Loop-log token bullet must NOT appear when real cost is present.
    expect(md).not.toContain("cumulative per turn");
    expect(md).toContain("scenario x");
  });

  it("keeps the loop-log token bullet when no cost json is present", () => {
    const log = [
      "[chat-runner] enter {",
      '[chat-runner] loop {\n  chatSessionId: "s",\n  loop: 1,\n  loopStop: "end_turn",\n  toolCalls: 2,\n  textChars: 1,\n  thinkingBlocks: 0,\n  tokensIn: 1000,\n  tokensOut: 50,\n}',
    ].join("\n");
    const md = buildReport({ log, reportRaw: REPORT, aiCostRaw: "" });
    expect(md).not.toContain("Real AI cost");
    expect(md).toContain("tokens in");
    expect(md).toContain("cumulative per turn");
  });

  it("degrades gracefully with all inputs empty", () => {
    const md = buildReport({ log: "", reportRaw: "", aiCostRaw: "" });
    expect(md).not.toContain("Real AI cost");
    expect(md).toContain("No chat-runner activity recorded");
  });
});
