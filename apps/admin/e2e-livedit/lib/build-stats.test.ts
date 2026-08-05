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

  // The CURRENT loop-line shape (incl. tokensCached between tokensIn and
  // tokensOut — the field whose arrival silently broke the previous
  // build-stats-local regex into reporting 0 loops; issue #432).
  const LOOP_LOG = [
    "[chat-runner] enter {",
    "[chat-runner] loop {",
    '  chatSessionId: "s",',
    "  loop: 0,",
    '  loopStop: "end_turn",',
    "  toolCalls: 2,",
    '  toolNames: [ "build_page", "add_module" ],',
    "  serverToolCalls: 0,",
    "  serverToolNames: [],",
    "  textChars: 1,",
    "  thinkingBlocks: 0,",
    "  inThisCall: 1000,",
    "  cacheRead: 800,",
    "  cacheWrite: 100,",
    "  freshIn: 100,",
    "  cacheHitPct: 80,",
    "  outThisCall: 50,",
    "  sentPrefixEstimate: 900,",
    "  tokensIn: 1000,",
    "  tokensCached: 800,",
    "  tokensOut: 50,",
    "}",
  ].join("\n");

  it("parses the current loop-line format — tokensCached must not zero the stats (issue #432)", () => {
    const md = buildReport({ log: LOOP_LOG, reportRaw: REPORT, aiCostRaw: "" });
    expect(md).toContain("**1** tool-call loops");
    expect(md).toContain("**2** tool calls dispatched");
    expect(md).toContain("1.0k** tokens in");
  });

  it("leads with the cost section and drops loop-log tokens when cost is present", () => {
    const md = buildReport({ log: LOOP_LOG, reportRaw: REPORT, aiCostRaw: FULL });
    expect(md.indexOf("Real AI cost")).toBeLessThan(md.indexOf("Chat-runner API stats"));
    expect(md).toContain("see **Real AI cost** above");
    // Loop-log token bullet must NOT appear when real cost is present.
    expect(md).not.toContain("per-call sums");
    expect(md).toContain("scenario x");
  });

  it("keeps the loop-log token bullet when no cost json is present", () => {
    const md = buildReport({ log: LOOP_LOG, reportRaw: REPORT, aiCostRaw: "" });
    expect(md).not.toContain("Real AI cost");
    expect(md).toContain("tokens in");
    expect(md).toContain("per-call sums");
  });

  it("degrades gracefully with all inputs empty", () => {
    const md = buildReport({ log: "", reportRaw: "", aiCostRaw: "" });
    expect(md).not.toContain("Real AI cost");
    expect(md).toContain("No chat-runner activity recorded");
  });

  it("renders the input-token breakdown table + breach warning from metrics.json", () => {
    const metricsRaw = JSON.stringify([
      {
        scenario: "homepage",
        loops: 33,
        inputTokens: 2_660_400,
        attribution: { staticPerCallTokens: 52_600, historyEndTokens: 62_400 },
        violations: [
          {
            metric: "inputTokens",
            actual: 2_660_400,
            limit: 2_000_000,
            message: "total input 2660.4k > ceiling 2000.0k",
          },
        ],
      },
      {
        scenario: "homepage",
        loops: 18,
        inputTokens: 1_200_000,
        attribution: { staticPerCallTokens: 52_600, historyEndTokens: 40_000 },
        violations: [],
      },
    ]);
    const md = buildReport({ log: LOOP_LOG, reportRaw: REPORT, aiCostRaw: "", metricsRaw });
    expect(md).toContain("### Input-token breakdown (per scenario attempt)");
    expect(md).toContain("| homepage | 33 | 2660.4k | 52.6k | 62.4k |");
    expect(md).toContain("**breached:** total input 2660.4k > ceiling 2000.0k");
    expect(md).toContain("| homepage (attempt 2) | 18 |");
    expect(md).toContain("1 attempt(s) breached token/loop thresholds");
  });

  it("omits the breakdown section when metrics.json is absent", () => {
    const md = buildReport({ log: LOOP_LOG, reportRaw: REPORT, aiCostRaw: "" });
    expect(md).not.toContain("Input-token breakdown");
  });
});
