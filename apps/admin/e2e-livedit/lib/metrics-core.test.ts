// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tier for the e2e-livedit metrics core (issue #432): parsing the
 * chat-runner traces (loop / tool-tokens / context-split), turn
 * aggregation, the input-attribution breakdown, threshold gating with the
 * re-derived ceilings, and the attempt-breach `::warning` lines.
 * Fixture text mirrors the real admin.log inspector output byte-for-byte
 * in shape (double-quoted strings, nested maps, trailing commas).
 */

import { describe, expect, it } from "bun:test";

import {
  aggregate,
  buildThresholdWarnings,
  checkThresholds,
  formatReport,
  metricsBySessionText,
  parseChatLog,
  summarizeScenario,
  THRESHOLDS,
} from "./metrics-core.js";

const S1 = "6ac646c7-c905-4e8d-b558-7fab501c3594";

function contextSplit(session: string, historyTokens: number): string {
  return [
    "[chat-runner] context-split {",
    `  chatSessionId: "${session}",`,
    '  estimator: "chars/4",',
    "  totalTokens: 53848,",
    "  systemPromptTokens: 3145,",
    "  toolCatalogueTokens: 47720,",
    "  contextBlockTokens: {",
    '    "finishing-a-turn": 300,',
    "    subagents: 314,",
    '    "skills-index": 1133,',
    "  },",
    "  skillTokens: {",
    '    "compose-page": 4100,',
    "  },",
    `  historyTokens: ${historyTokens},`,
    "  historyMessages: 2,",
    "}",
  ].join("\n");
}

function loopLine(
  session: string,
  loop: number,
  stop: string,
  tools: string[],
  inCall: number,
  prefixEst: number,
): string {
  return [
    "[chat-runner] loop {",
    `  chatSessionId: "${session}",`,
    `  loop: ${loop},`,
    `  loopStop: "${stop}",`,
    `  toolCalls: ${tools.length},`,
    `  toolNames: [ ${tools.map((t) => `"${t}"`).join(", ")} ],`,
    "  serverToolCalls: 0,",
    "  serverToolNames: [],",
    "  textChars: 42,",
    "  thinkingBlocks: 0,",
    `  inThisCall: ${inCall},`,
    `  cacheRead: ${Math.round(inCall * 0.9)},`,
    "  cacheWrite: 1000,",
    `  freshIn: ${inCall - Math.round(inCall * 0.9) - 1000},`,
    "  cacheHitPct: 90,",
    "  outThisCall: 200,",
    `  sentPrefixEstimate: ${prefixEst},`,
    `  tokensIn: ${inCall},`,
    `  tokensCached: ${Math.round(inCall * 0.9)},`,
    "  tokensOut: 200,",
    "}",
  ].join("\n");
}

function toolTokens(session: string, loop: number, entries: [string, number][]): string {
  return [
    "[chat-runner] tool-tokens {",
    `  chatSessionId: "${session}",`,
    `  loop: ${loop},`,
    "  results: [",
    ...entries.map(([name, tokens]) => `    { name: "${name}", ok: true, tokens: ${tokens} },`),
    "  ],",
    "}",
  ].join("\n");
}

/** Two turns in one session: 3-loop build turn + 2-loop edit turn. */
const FIXTURE = [
  contextSplit(S1, 1200),
  loopLine(S1, 0, "tool_use", ["load_skill"], 35_000, 1200),
  toolTokens(S1, 0, [["load_skill", 1200]]),
  loopLine(S1, 1, "tool_use", ["build_page", "add_module"], 40_000, 5000),
  toolTokens(S1, 1, [
    ["build_page", 300],
    ["add_module", 100],
  ]),
  loopLine(S1, 2, "end_turn", [], 45_000, 9000),
  contextSplit(S1, 20_000),
  loopLine(S1, 0, "tool_use", ["set_page_module_content"], 60_000, 20_000),
  toolTokens(S1, 0, [["set_page_module_content", 50]]),
  loopLine(S1, 1, "end_turn", [], 62_000, 22_000),
].join("\n");

describe("parseChatLog", () => {
  it("parses loop rows despite tokensCached sitting between tokensIn and tokensOut", () => {
    const { loops } = parseChatLog(FIXTURE);
    expect(loops).toHaveLength(5);
    expect(loops[0]?.inCall).toBe(35_000);
    expect(loops[0]?.out).toBe(200);
    expect(loops[1]?.toolNames).toEqual(["build_page", "add_module"]);
    expect(loops[2]?.prefixEst).toBe(9000);
  });

  it("parses context-split records including nested per-block and per-skill maps", () => {
    const { splits } = parseChatLog(FIXTURE);
    expect(splits).toHaveLength(2);
    const s = splits[0];
    expect(s?.systemPromptTokens).toBe(3145);
    expect(s?.toolCatalogueTokens).toBe(47_720);
    expect(s?.contextBlockTokens).toEqual({
      "finishing-a-turn": 300,
      subagents: 314,
      "skills-index": 1133,
    });
    expect(s?.skillTokens).toEqual({ "compose-page": 4100 });
    expect(s?.historyTokens).toBe(1200);
  });

  it("parses tool-token results", () => {
    const { tools } = parseChatLog(FIXTURE);
    expect(tools).toHaveLength(3);
    expect(tools[1]?.results).toEqual([
      { name: "build_page", ok: true, tokens: 300 },
      { name: "add_module", ok: true, tokens: 100 },
    ]);
  });
});

describe("aggregate + attribution", () => {
  const { loops, tools, splits } = parseChatLog(FIXTURE);
  const m = aggregate(loops, tools, splits);

  it("splits turns on the loop-counter reset and attaches one context-split per turn", () => {
    expect(m.turns).toHaveLength(2);
    expect(m.turns[0]?.totals.loops).toBe(3);
    expect(m.turns[1]?.totals.loops).toBe(2);
    expect(m.turns[0]?.split?.historyTokens).toBe(1200);
    expect(m.turns[1]?.split?.historyTokens).toBe(20_000);
  });

  it("derives the input attribution: static-per-call, static total, history total + end", () => {
    const a = m.attribution;
    expect(a).toBeDefined();
    if (!a) return;
    // static/call = system + tools + blocks + skills = 3145+47720+1747+4100
    expect(a.staticPerCallTokens).toBe(56_712);
    expect(a.systemPromptTokens).toBe(3145);
    expect(a.toolCatalogueTokens).toBe(47_720);
    expect(a.contextBlockTokens).toBe(1747);
    expect(a.skillTokens).toEqual({ "compose-page": 4100 });
    // Both turns share the same split figures: 56,712 × (3+2) loops.
    expect(a.staticTotalTokens).toBe(56_712 * 5);
    // History = Σ sentPrefixEstimate = 1200+5000+9000+20000+22000.
    expect(a.historyTotalTokens).toBe(57_200);
    expect(a.historyEndTokens).toBe(22_000);
    expect(a.historyPeakTokens).toBe(22_000);
    expect(a.estCoveragePct).toBeGreaterThan(0);
  });

  it("degrades to attribution: undefined when the log has no context-split lines", () => {
    const noSplits = aggregate(loops, tools, []);
    expect(noSplits.attribution).toBeUndefined();
    expect(formatReport("x", noSplits)).toContain("INPUT ATTRIBUTION: n/a");
  });

  it("renders the per-loop hist column and the attribution block in the report", () => {
    const report = formatReport("homepage", m);
    expect(report).toContain("| hist   | tools");
    expect(report).toContain("INPUT ATTRIBUTION");
    expect(report).toContain("tool-catalogue 47.7k");
    expect(report).toContain("compose-page 4.1k");
    expect(report).toContain("history growth:");
  });

  it("groups whole-log text per session", () => {
    const per = metricsBySessionText(FIXTURE);
    expect(per).toHaveLength(1);
    expect(per[0]?.session).toBe(S1);
    expect(per[0]?.metrics.turns).toHaveLength(2);
  });
});

describe("thresholds (issue #432 re-derived ceilings)", () => {
  const { loops, tools, splits } = parseChatLog(FIXTURE);
  const m = aggregate(loops, tools, splits);

  it("homepage ceilings sit above the measured healthy band and below the spiral band", () => {
    const th = THRESHOLDS.homepage;
    expect(th?.maxInputTokens).toBe(2_000_000);
    expect(th?.maxLoops).toBe(26);
    // Worst measured HEALTHY first attempt (1646.5k / 21 loops) must pass…
    expect(1_646_500).toBeLessThan(th?.maxInputTokens ?? 0);
    expect(21).toBeLessThan(th?.maxLoops ?? 0);
    // …and every observed corruption-spiral attempt must still fail.
    for (const [input, loopCount] of [
      [2_176_900, 27],
      [2_505_600, 31],
      [2_660_400, 33],
    ] as const) {
      const breachedInput = input > (th?.maxInputTokens ?? Number.POSITIVE_INFINITY);
      const breachedLoops = loopCount > (th?.maxLoops ?? Number.POSITIVE_INFINITY);
      expect(breachedInput || breachedLoops).toBe(true);
    }
  });

  it("checkThresholds flags input + loop ceilings with actionable messages", () => {
    const v = checkThresholds(m, { maxInputTokens: 100_000, maxLoops: 3 });
    expect(v.map((x) => x.metric).sort()).toEqual(["inputTokens", "loops"]);
    expect(v.find((x) => x.metric === "inputTokens")?.message).toContain("ceiling");
  });

  it("passes when under all thresholds", () => {
    expect(checkThresholds(m, THRESHOLDS.homepage ?? {})).toEqual([]);
  });
});

describe("summaries + attempt-breach warnings", () => {
  const { loops, tools, splits } = parseChatLog(FIXTURE);
  const m = aggregate(loops, tools, splits);

  it("summarizeScenario carries attribution + violations into the jsonl row", () => {
    const violations = checkThresholds(m, { maxLoops: 3 });
    const row = summarizeScenario("homepage", m, violations);
    expect(row.scenario).toBe("homepage");
    expect(row.loops).toBe(5);
    expect(row.attribution?.staticPerCallTokens).toBe(56_712);
    expect(row.violations).toHaveLength(1);
  });

  it("buildThresholdWarnings emits one ::warning per breached attempt, numbering attempts", () => {
    const clean = summarizeScenario("homepage", m, []);
    const breached = summarizeScenario("homepage", m, checkThresholds(m, { maxLoops: 3 }));
    const warnings = buildThresholdWarnings([clean, breached]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith("::warning title=e2e-livedit thresholds");
    expect(warnings[0]).toContain("attempt 2");
    expect(warnings[0]).toContain("loops 5 > ceiling 3");
  });

  it("emits nothing when no attempt breached", () => {
    expect(buildThresholdWarnings([summarizeScenario("homepage", m, [])])).toEqual([]);
  });
});
