// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { OpenProblem } from "../gate.js";
import { groupOpenProblems, groupSummaryLine, problemGroupKey } from "../problem-groups.js";

const missing = (pageId: string | null, pagePath: string, count = 1): OpenProblem => ({
  pageId,
  pagePath,
  problem: {
    kind: "check_rule",
    checkId: "seo-check",
    ruleId: "seo-check/description-missing",
    count,
    allowed: 0,
    findings: [{ message: "Missing meta description" }],
  },
});

const unusedJs = (pageId: string, pagePath: string): OpenProblem => ({
  pageId,
  pagePath,
  problem: {
    kind: "failing_audit",
    auditId: "unused-javascript",
    title: "Reduce unused JavaScript",
    score: 0.5,
    categories: ["performance"],
    displayValue: "Est savings of 120 KiB",
  },
});

describe("problemGroupKey", () => {
  it("names what failed, independent of the page", () => {
    expect(problemGroupKey(missing("p", "/").problem)).toEqual({
      key: "seo-check/description-missing",
      ref: { ruleId: "seo-check/description-missing" },
    });
    expect(problemGroupKey(unusedJs("p", "/").problem)).toEqual({
      key: "lighthouse/performance/unused-javascript",
      ref: { auditId: "unused-javascript" },
    });
    expect(
      problemGroupKey({
        kind: "score_below_baseline",
        category: "accessibility",
        score: 92,
        baseline: 100,
      }),
    ).toEqual({ key: "lighthouse/accessibility/score", ref: { category: "accessibility" } });
  });
});

describe("groupOpenProblems", () => {
  it("groups one rule across pages (site-wide included), biggest group first", () => {
    const groups = groupOpenProblems([
      unusedJs("p1", "/"),
      missing("p1", "/"),
      missing("p2", "/about", 2),
      missing(null, "site-wide"),
    ]);
    expect(groups.map((g) => [g.key, g.pages.map((p) => p.pagePath)])).toEqual([
      ["seo-check/description-missing", ["/", "/about", "site-wide"]],
      ["lighthouse/performance/unused-javascript", ["/"]],
    ]);
    expect(groups[0]?.title).toBe("Missing meta description");
    expect(groups[0]?.pages[1]).toEqual({ pageId: "p2", pagePath: "/about", detail: "2×" });
    expect(groups[1]?.pages[0]?.detail).toBe("Est savings of 120 KiB");
  });

  it("scales to hundreds of pages in one group", () => {
    const many = Array.from({ length: 312 }, (_v, i) => missing(`p${i}`, `/p${i}`));
    const [group] = groupOpenProblems(many);
    expect(group?.pages).toHaveLength(312);
    expect(groupSummaryLine(group as NonNullable<typeof group>)).toBe(
      "seo-check/description-missing — Missing meta description: 312 page(s) (/p0, /p1, /p2, +309)",
    );
  });
});
