// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  buildReport,
  formatBugSection,
  formatCostSection,
  parseAiCost,
  parseBugReports,
} from "./build-stats.js";

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

/** One `ai_bug_reports` row as the workflow's psql capture emits it. */
function bugRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    createdAt: "2026-08-05 10:00:00+00",
    chatSessionId: "22222222-2222-2222-2222-222222222222",
    title: "create_module drops nested fields",
    whatHappened: "The nested module-list field came back empty.",
    expected: "The two child modules should have been persisted.",
    suspectedTool: "create_module",
    evidence: null,
    severity: "degraded",
    blockedTask: false,
    status: "new",
    source: "ai",
    ...over,
  };
}

const BUGS = JSON.stringify([
  bugRow({ severity: "cosmetic", source: "ai", title: "list_modules description truncated" }),
  bugRow({
    severity: "blocking",
    source: "auto",
    title: "messages.4: tool_use ids were found without tool_result blocks",
    suspectedTool: null,
    blockedTask: true,
    evidence: "#0 user\n#1 assistant tool_use[toolu_01!UNANSWERED]",
  }),
  bugRow({ severity: "degraded", source: "auto", title: "pages.add_module → ValidationFailed" }),
]);

describe("parseBugReports", () => {
  it("parses a well-formed row array", () => {
    const rows = parseBugReports(BUGS);
    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.severity).toBe("cosmetic");
    expect(rows?.[1]?.blockedTask).toBe(true);
    expect(rows?.[1]?.suspectedTool).toBeNull();
  });

  it("returns null for a missing file (empty string)", () => {
    expect(parseBugReports("")).toBeNull();
    expect(parseBugReports("   \n ")).toBeNull();
  });

  it("returns null for the {} capture-failure sentinel", () => {
    // Distinct from `[]` — a failed capture must not look like a clean run.
    expect(parseBugReports("{}")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseBugReports("not json at all")).toBeNull();
    expect(parseBugReports("[ broken")).toBeNull();
  });

  it("returns an empty array for a capture that found nothing", () => {
    expect(parseBugReports("[]")).toEqual([]);
  });

  it("salvages JSON behind a stray psql command tag", () => {
    expect(parseBugReports(`SET\n${BUGS}`)).toHaveLength(3);
  });

  it("coerces missing/nullable columns without throwing", () => {
    const rows = parseBugReports(JSON.stringify([{}]));
    expect(rows?.[0]?.title).toBe("");
    expect(rows?.[0]?.evidence).toBeNull();
    expect(rows?.[0]?.blockedTask).toBe(false);
  });
});

describe("formatBugSection", () => {
  it("omits the section entirely when the capture is absent", () => {
    expect(formatBugSection(null)).toEqual([]);
  });

  it("renders an explicit zero-state for a clean run", () => {
    const md = formatBugSection([]).join("\n");
    expect(md).toContain("### Detected bugs (0)");
    expect(md).toContain("_None filed during this run._");
  });

  it("orders blocking first, then degraded, then cosmetic", () => {
    const md = formatBugSection(parseBugReports(BUGS)).join("\n");
    expect(md).toContain("### Detected bugs (3)");
    const blocking = md.indexOf("tool_use ids were found");
    const degraded = md.indexOf("pages.add_module");
    const cosmetic = md.indexOf("list_modules description");
    expect(blocking).toBeLessThan(degraded);
    expect(degraded).toBeLessThan(cosmetic);
  });

  it("renders the table columns, the source, and the blocked flag", () => {
    const md = formatBugSection(parseBugReports(BUGS)).join("\n");
    expect(md).toContain("| Sev | Source | Title | Tool | Blocked |");
    expect(md).toContain("| blocking | auto |");
    expect(md).toContain("`create_module`");
    // A null suspected_tool renders as an em dash, not an empty cell.
    expect(md).toContain("| — | yes |");
  });

  it("carries diagnosis in a collapsed details block", () => {
    const md = formatBugSection(parseBugReports(BUGS)).join("\n");
    expect(md).toContain("<summary>Bug details (3)</summary>");
    expect(md).toContain("- What happened:");
    expect(md).toContain("!UNANSWERED");
  });

  it("keeps evidence newlines — the provider-error digest is line-oriented", () => {
    const rows = parseBugReports(
      JSON.stringify([bugRow({ evidence: "#0 user\n#1 assistant tool_use[toolu_01!UNANSWERED]" })]),
    );
    const md = formatBugSection(rows).join("\n");
    expect(md).toContain("#0 user\n#1 assistant");
  });

  it("groups sources within a severity band", () => {
    const rows = parseBugReports(
      JSON.stringify([
        bugRow({ severity: "degraded", source: "auto", title: "auto one" }),
        bugRow({ severity: "degraded", source: "ai", title: "ai one" }),
        bugRow({ severity: "degraded", source: "auto", title: "auto two" }),
      ]),
    );
    const md = formatBugSection(rows).join("\n");
    expect(md.indexOf("ai one")).toBeLessThan(md.indexOf("auto one"));
    expect(md.indexOf("auto one")).toBeLessThan(md.indexOf("auto two"));
  });

  it("caps the table and says out loud what it dropped", () => {
    const many = Array.from({ length: 63 }, (_, i) => bugRow({ title: `bug number ${i}` }));
    const md = formatBugSection(parseBugReports(JSON.stringify(many))).join("\n");
    // The heading reports the true total even though the table is capped.
    expect(md).toContain("### Detected bugs (63)");
    expect(md).toContain("…13 more not shown");
    expect(md).toContain("e2e-livedit-bugs-<run_id>");
  });

  it("truncates long titles and evidence to keep the comment under GitHub's limit", () => {
    const rows = parseBugReports(
      JSON.stringify([bugRow({ title: "T".repeat(300), evidence: "E".repeat(2000) })]),
    );
    const lines = formatBugSection(rows);
    // Table cell caps at 80, the details heading at 200, evidence at 600.
    const tableRow = lines.find((l) => l.startsWith("| degraded |"));
    expect(tableRow).toBeDefined();
    expect(tableRow?.match(/T+…/)?.[0]).toHaveLength(80);
    expect(lines.find((l) => l.startsWith("**1."))?.match(/T+…/)?.[0]).toHaveLength(200);
    expect(lines.find((l) => l.startsWith("E"))).toHaveLength(600);
  });

  // Regression: CodeQL js/incomplete-sanitization (alert #134 on PR #440).
  // A backslash escape has to escape the backslash first; entities don't.
  it("neutralizes pipes with an entity, leaving no escape character to mishandle", () => {
    const rows = parseBugReports(JSON.stringify([bugRow({ title: "a | b" })]));
    const md = formatBugSection(rows).join("\n");
    expect(md).toContain("a &#124; b");
    expect(md).not.toContain("\\|");
  });

  it("keeps a trailing backslash from smuggling a pipe past the escape", () => {
    // `x \` + `| y` under backslash-escaping renders as `x \\| y` — the escape
    // escapes the backslash and the pipe splits the row. Entities can't.
    const rows = parseBugReports(JSON.stringify([bugRow({ title: "x \\| y" })]));
    const row = formatBugSection(rows).find((l) => l.startsWith("| degraded |"));
    // Exactly the 5 table columns ⇒ 6 delimiters. No injected extra cell.
    expect(row?.split("|")).toHaveLength(7);
  });

  // Regression: the AI security review on PR #440 — evidence containing a
  // fence as wide as the opener would close it and inject free markdown
  // (fake tables, fake warnings) into the PR comment body.
  it("widens the evidence fence past any backtick run in the content", () => {
    const rows = parseBugReports(
      JSON.stringify([bugRow({ evidence: "before\n````\n| Sev | fake row |\n````\nafter" })]),
    );
    const lines = formatBugSection(rows);
    const open = lines.findIndex((l) => /^`{3,}$/.test(l));
    const fence = lines[open];
    expect(fence).toBe("`````");
    // The body sits between a matched pair, so nothing escapes into markdown.
    expect(lines.lastIndexOf(fence)).toBeGreaterThan(open);
    expect(lines.filter((l) => l === fence)).toHaveLength(2);
  });

  it("still uses a plain fence for evidence with no backticks", () => {
    const rows = parseBugReports(JSON.stringify([bugRow({ evidence: "no fences here" })]));
    const lines = formatBugSection(rows);
    expect(lines.filter((l) => l === "```")).toHaveLength(2);
  });

  it("stops a backtick in suspected_tool from closing its code span", () => {
    const rows = parseBugReports(JSON.stringify([bugRow({ suspectedTool: "a`b" })]));
    const md = formatBugSection(rows).join("\n");
    expect(md).toContain("`a'b`");
  });

  it("neutralizes a </details> that would break the collapsible block open", () => {
    const rows = parseBugReports(
      JSON.stringify([bugRow({ whatHappened: "then </details> happened" })]),
    );
    const md = formatBugSection(rows).join("\n");
    expect(md).toContain("&lt;/details>");
    expect(md.match(/<\/details>/g)).toHaveLength(1);
  });

  it("escapes the ampersand first, so a pre-encoded tag cannot slip through", () => {
    // Without escaping `&`, this passes through unchanged and the renderer
    // decodes it back into a real closing tag.
    const rows = parseBugReports(
      JSON.stringify([bugRow({ whatHappened: "literal &lt;/details> in the text" })]),
    );
    const md = formatBugSection(rows).join("\n");
    expect(md).toContain("&amp;lt;/details>");
    expect(md.match(/<\/details>/g)).toHaveLength(1);
  });

  it("shows module HTML in evidence bullets instead of letting it render as tags", () => {
    const rows = parseBugReports(
      JSON.stringify([bugRow({ expected: 'the <section class="hero"> should persist' })]),
    );
    const md = formatBugSection(rows).join("\n");
    expect(md).toContain('&lt;section class="hero">');
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
    const md = buildReport({ log, reportRaw: REPORT, aiCostRaw: FULL, bugsRaw: "" });
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
    const md = buildReport({ log, reportRaw: REPORT, aiCostRaw: "", bugsRaw: "" });
    expect(md).not.toContain("Real AI cost");
    expect(md).toContain("tokens in");
    expect(md).toContain("cumulative per turn");
  });

  it("degrades gracefully with all inputs empty", () => {
    const md = buildReport({ log: "", reportRaw: "", aiCostRaw: "", bugsRaw: "" });
    expect(md).not.toContain("Real AI cost");
    expect(md).toContain("No chat-runner activity recorded");
    // No capture ⇒ no section at all, same contract as the cost section.
    expect(md).not.toContain("Detected bugs");
  });

  it("places detected bugs after the per-scenario verdict they qualify", () => {
    const md = buildReport({ log: "", reportRaw: REPORT, aiCostRaw: "", bugsRaw: BUGS });
    expect(md.indexOf("Per-scenario results")).toBeLessThan(md.indexOf("### Detected bugs"));
    expect(md).toContain("### Detected bugs (3)");
  });

  it("reports a green run's clean bug slate rather than staying silent", () => {
    const md = buildReport({ log: "", reportRaw: REPORT, aiCostRaw: "", bugsRaw: "[]" });
    expect(md).toContain("### Detected bugs (0)");
  });
});
