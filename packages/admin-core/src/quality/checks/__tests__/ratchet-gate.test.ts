// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  formatCheckNotes,
  formatCheckProblem,
  formatChecksSummary,
} from "../../../ai/tools/quality-check-format.js";
import { chatFeedbackFor } from "../../chat-feedback.js";
import { CURRENT_GATE_RULES, checkKey, decideGate, type GateAudit } from "../../gate.js";
import { groupOpenProblems } from "../../problem-groups.js";
import { type CheckRuleProblem, evaluateCheckFindings, tightenedAcceptances } from "../evaluate.js";
import type { Finding } from "../findings.js";

const P = "00000000-0000-4000-8000-000000000001";

function err(ruleId: string, message = "Missing alt: img 1"): Finding {
  return {
    ruleId,
    severity: "error",
    pageId: P,
    message,
    fix: { tool: "set_media_alt_many", hint: "describe it" },
  };
}

describe("evaluateCheckFindings (the per-rule ratchet)", () => {
  it("every error counts without an acceptance; warnings and info never do", () => {
    const problems = evaluateCheckFindings(
      [err("img/alt"), err("img/alt"), { ...err("img/size"), severity: "warning" }],
      new Map(),
    );
    expect(problems).toEqual([
      expect.objectContaining({
        kind: "check_rule",
        checkId: "img",
        ruleId: "img/alt",
        count: 2,
        allowed: 0,
      }),
    ]);
    expect(problems[0]?.findings[0]?.fix?.tool).toBe("set_media_alt_many");
  });

  // #727 — accepted rules stay recorded as problems (with the count the
  // acceptance allowed, for the record); the gate applies the live
  // acceptance, so a revoke blocks again at once.
  it("records an accepted rule as a problem with its allowed count", () => {
    expect(
      evaluateCheckFindings([err("img/alt"), err("img/alt")], new Map([["img/alt", 2]])),
    ).toEqual([expect.objectContaining({ ruleId: "img/alt", count: 2, allowed: 2 })]);
    const over = evaluateCheckFindings(
      [err("img/alt"), err("img/alt"), err("img/alt")],
      new Map([["img/alt", 2]]),
    );
    expect(over[0]).toMatchObject({ count: 3, allowed: 2 });
  });

  it("keeps at most five example findings per problem", () => {
    const many = Array.from({ length: 9 }, (_, i) => err("img/alt", `Missing alt: ${i}`));
    expect(evaluateCheckFindings(many, new Map())[0]?.findings).toHaveLength(5);
  });

  it("tightens acceptances to what was measured — only for checks that measured", () => {
    const accepted = new Map([
      ["img/alt", 3],
      ["img/size", 2],
      ["broken/x", 4],
    ]);
    const next = tightenedAcceptances(accepted, [err("img/alt")], new Set(["img"]));
    expect([...next]).toEqual([
      ["img/alt", 1],
      ["img/size", 0],
    ]);
  });
});

describe("the gate with page-check problems", () => {
  const problem: CheckRuleProblem = {
    kind: "check_rule",
    checkId: "img",
    ruleId: "img/alt",
    count: 2,
    allowed: 0,
    findings: [{ message: "Missing alt: logo" }],
  };
  const audit: GateAudit = {
    id: "a1",
    gateRules: CURRENT_GATE_RULES,
    status: "problems",
    errorCode: null,
    errorMessage: null,
    publishOverride: null,
    pages: [{ pageId: P, pagePath: "/team", problems: [problem] }],
    siteProblems: [{ ...problem, ruleId: "robots/blocked", checkId: "robots", count: 1 }],
  };
  const none = { findings: new Map<string, number | null>(), scores: new Map<string, number>() };

  it("blocks on page and site-wide problems, naming both", () => {
    const d = decideGate(audit, { ...none, checks: new Map() });
    expect(d).toMatchObject({ open: false, state: "problems" });
    expect(d.openProblems.map((p) => p.pageId)).toEqual([P, null]);
    expect(d.message).toContain("/team: img/alt (2×)");
    expect(d.message).toContain("site-wide: robots/blocked (1×)");
  });

  it("acceptances count per page/site and only up to their count", () => {
    const partial = decideGate(audit, {
      ...none,
      checks: new Map([
        [checkKey(P, "img/alt"), 1],
        [checkKey(null, "robots/blocked"), 1],
      ]),
    });
    expect(partial.openProblems.map((p) => p.pagePath)).toEqual(["/team"]);
    const all = decideGate(audit, {
      ...none,
      checks: new Map([
        [checkKey(P, "img/alt"), 2],
        [checkKey(null, "robots/blocked"), 1],
      ]),
    });
    expect(all).toMatchObject({ open: true, state: "accepted" });
    // A site-wide acceptance never covers a page, nor the other way round.
    const crossed = decideGate(audit, {
      ...none,
      checks: new Map([
        [checkKey(null, "img/alt"), 9],
        [checkKey(P, "robots/blocked"), 9],
      ]),
    });
    expect(crossed.openProblems).toHaveLength(2);
  });

  it("the chat and the AI get labels, counts and the fix hint", () => {
    expect(groupOpenProblems([{ pageId: P, pagePath: "/team", problem }])[0]).toMatchObject({
      key: "img/alt",
      title: "Missing alt",
      pages: [{ pagePath: "/team", detail: "2×" }],
    });
    const lines = formatCheckProblem({
      ...problem,
      allowed: 1,
      findings: [
        { message: "Missing alt: logo", fix: { tool: "set_media_alt_many", hint: "describe" } },
      ],
    });
    expect(lines[0]).toBe("- PROBLEM page check `img/alt` — 2 error(s)");
    expect(formatCheckProblem(problem, true)[0]).toContain("ACCEPTED by an editor (does not block");
    expect(lines).toContain("  - … and 1 more of this rule");
    expect(lines).toContain("  fix: `set_media_alt_many` — describe");
    expect(formatCheckNotes([{ ...err("img/size"), severity: "info" }])[0]).toContain(
      "hint `img/size` (does not block)",
    );
    const summary = formatChecksSummary({
      ran: [{ id: "img", title: "Images", scope: "page", source: { kind: "core" } }],
      pagesChecked: 4,
      findingCounts: { error: 2, warning: 0, info: 0 },
      siteFindings: [],
      siteProblems: [],
      errors: [{ checkId: null, code: "page-status", message: "staging answered 404 for /x" }],
    });
    expect(summary[0]).toContain("img — 4 page(s) read; 2 error(s)");
    expect(summary[1]).toBe("- CHECK FAILED: staging answered 404 for /x");
  });

  it("says no page check is installed instead of reporting 0 pages read", () => {
    const [line] = formatChecksSummary({
      ran: [],
      pagesChecked: 0,
      findingCounts: { error: 0, warning: 0, info: 0 },
      siteFindings: [],
      siteProblems: [],
      errors: [],
    });
    expect(line).toContain("none installed");
    expect(line).not.toContain("page(s) read");
  });

  it("a passed Stage without Lighthouse says so in the chat", () => {
    const base = {
      status: "passed" as const,
      fixRound: 0,
      groups: [],
      stagedBy: null,
      errorCode: null,
      errorMessage: null,
      skippedBecause: ["field values: hero"],
      fixChain: null,
    };
    expect(chatFeedbackFor({ ...base, lighthouse: false })?.text).toContain(
      "page checks on every page; no Lighthouse audit needed: field values: hero",
    );
    expect(chatFeedbackFor({ ...base, lighthouse: true })?.text).toContain(
      "Lighthouse: Performance",
    );
  });
});
