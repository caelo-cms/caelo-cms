// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type BaselineState,
  evaluatePage,
  type FailingAudit,
  INITIAL_BASELINE,
  medianScore,
  type PageMeasurement,
  type QualityCategory,
} from "../ratchet.js";

const ALL_100 = { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 };

function measure(
  scores: Partial<Record<QualityCategory, number>>,
  failingAudits: FailingAudit[] = [],
): PageMeasurement {
  return { scores: { ...ALL_100, ...scores }, failingAudits };
}

function evaluate(
  measurement: PageMeasurement,
  baselines: Partial<Record<QualityCategory, BaselineState>> = {},
  accepted: string[] = [],
  previousHeldBack: string[] = [],
) {
  return evaluatePage({
    measurement,
    baselines,
    acceptedAuditIds: new Set(accepted),
    previousHeldBackFindings: new Set(previousHeldBack),
  });
}

const imageAlt: FailingAudit = {
  id: "image-alt",
  title: "Image elements do not have [alt] attributes",
  score: 0,
  categories: ["accessibility"],
  displayValue: "1 element",
};
const unusedJs: FailingAudit = {
  id: "unused-javascript",
  title: "Reduce unused JavaScript",
  score: 0.5,
  categories: ["performance"],
};

describe("evaluatePage — baselines", () => {
  it("a never-audited page at 100 everywhere is clean and keeps baselines at 100", () => {
    const e = evaluate(measure({}));
    expect(e.problems).toEqual([]);
    expect(e.heldBack).toEqual([]);
    for (const b of Object.values(e.nextBaselines)) {
      expect(b).toEqual({ baseline: INITIAL_BASELINE, belowStreak: 0 });
    }
  });

  it("a deterministic category below the initial 100 triggers immediately", () => {
    const e = evaluate(measure({ accessibility: 95, seo: 92, "best-practices": 96 }));
    expect(e.problems).toEqual([
      { kind: "score_below_baseline", category: "accessibility", score: 95, baseline: 100 },
      { kind: "score_below_baseline", category: "best-practices", score: 96, baseline: 100 },
      { kind: "score_below_baseline", category: "seo", score: 92, baseline: 100 },
    ]);
    // A drop never lowers the baseline by itself (only an acceptance does).
    expect(e.nextBaselines.accessibility).toEqual({ baseline: 100, belowStreak: 0 });
  });

  it("ratchet: an accepted 99 is the baseline, a later 98 triggers, 99 is fine", () => {
    const accepted99 = { accessibility: { baseline: 99, belowStreak: 0 } };
    expect(evaluate(measure({ accessibility: 99 }), accepted99).problems).toEqual([]);
    expect(evaluate(measure({ accessibility: 98 }), accepted99).problems).toEqual([
      { kind: "score_below_baseline", category: "accessibility", score: 98, baseline: 99 },
    ]);
  });

  it("ratchet: an improvement raises the baseline automatically", () => {
    const e = evaluate(measure({ accessibility: 100 }), {
      accessibility: { baseline: 99, belowStreak: 0 },
    });
    expect(e.nextBaselines.accessibility).toEqual({ baseline: 100, belowStreak: 0 });
    // …so the next 99 is a problem again.
    const next = evaluate(measure({ accessibility: 99 }), {
      accessibility: e.nextBaselines.accessibility,
    });
    expect(next.problems).toHaveLength(1);
  });
});

describe("evaluatePage — Performance noise guard", () => {
  it("one jittery run below the baseline is held back, not a problem", () => {
    const e = evaluate(measure({ performance: 97 }));
    expect(e.problems).toEqual([]);
    expect(e.heldBack).toEqual([{ kind: "performance_drop", score: 97, baseline: 100 }]);
    expect(e.nextBaselines.performance).toEqual({ baseline: 100, belowStreak: 1 });
  });

  it("two consecutive audits below the baseline trigger", () => {
    const first = evaluate(measure({ performance: 97 }));
    const second = evaluate(measure({ performance: 96 }), {
      performance: first.nextBaselines.performance,
    });
    expect(second.problems).toEqual([
      { kind: "score_below_baseline", category: "performance", score: 96, baseline: 100 },
    ]);
    expect(second.nextBaselines.performance).toEqual({ baseline: 100, belowStreak: 2 });
  });

  it("a recovered audit in between resets the streak", () => {
    const first = evaluate(measure({ performance: 97 }));
    const recovered = evaluate(measure({ performance: 100 }), {
      performance: first.nextBaselines.performance,
    });
    expect(recovered.nextBaselines.performance).toEqual({ baseline: 100, belowStreak: 0 });
    const again = evaluate(measure({ performance: 97 }), {
      performance: recovered.nextBaselines.performance,
    });
    expect(again.problems).toEqual([]);
  });

  it("a Performance-only finding needs two consecutive audits too", () => {
    const first = evaluate(measure({}, [unusedJs]));
    expect(first.problems).toEqual([]);
    expect(first.heldBack).toEqual([
      { kind: "performance_finding", auditId: "unused-javascript", title: unusedJs.title },
    ]);
    const second = evaluate(measure({}, [unusedJs]), {}, [], ["unused-javascript"]);
    expect(second.problems.map((p) => p.kind === "failing_audit" && p.auditId)).toEqual([
      "unused-javascript",
    ]);
  });
});

describe("evaluatePage — findings and acceptances", () => {
  it("a failing non-Performance audit is a problem at once", () => {
    const e = evaluate(measure({}, [imageAlt]));
    expect(e.problems).toEqual([
      {
        kind: "failing_audit",
        auditId: "image-alt",
        title: imageAlt.title,
        score: 0,
        categories: ["accessibility"],
        displayValue: "1 element",
      },
    ]);
  });

  it("an accepted finding no longer blocks on that page", () => {
    expect(evaluate(measure({}, [imageAlt]), {}, ["image-alt"]).problems).toEqual([]);
  });

  it("an accepted Performance finding is neither a problem nor held back", () => {
    const e = evaluate(measure({}, [unusedJs]), {}, ["unused-javascript"]);
    expect(e.problems).toEqual([]);
    expect(e.heldBack).toEqual([]);
  });
});

describe("medianScore", () => {
  it("takes the middle of an odd count and the rounded mean of an even one", () => {
    expect(medianScore([90, 100, 80])).toBe(90);
    expect(medianScore([99])).toBe(99);
    expect(medianScore([97, 98])).toBe(98);
  });

  it("refuses an empty list (an audit without runs is a failure, not a score)", () => {
    expect(() => medianScore([])).toThrow(/no Performance runs/);
  });
});
