// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  ACCEPTED_PERFORMANCE_TOLERANCE,
  acceptedValueCovers,
  evaluatePage,
  type FailingAudit,
  type LighthouseAcceptance,
  lighthouseAcceptanceUpdates,
  medianScore,
  type PageMeasurement,
  type QualityCategory,
} from "../ratchet.js";
import { sampleMetrics } from "./fixtures/sample-metrics.js";

const ALL_100 = { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 };

function measure(
  scores: Partial<Record<QualityCategory, number>>,
  failingAudits: FailingAudit[] = [],
): PageMeasurement {
  return { scores: { ...ALL_100, ...scores }, failingAudits, metrics: sampleMetrics() };
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
const responsiveImages: FailingAudit = {
  id: "uses-responsive-images",
  title: "Properly size images",
  score: 0.6,
  categories: ["performance", "best-practices"],
};

describe("evaluatePage — the target is 100 (#727 'optimum, not good enough')", () => {
  it("a page at 100 everywhere without failing audits is clean", () => {
    expect(evaluatePage(measure({}))).toEqual([]);
  });

  it("every category below 100 is a problem — 99 and 90 alike, no baseline", () => {
    expect(evaluatePage(measure({ performance: 99, seo: 90 }))).toEqual([
      { kind: "score_below_baseline", category: "performance", score: 99, baseline: 100 },
      { kind: "score_below_baseline", category: "seo", score: 90, baseline: 100 },
    ]);
  });

  it("every failing audit is a problem, Performance-only ones included (no noise streak)", () => {
    const problems = evaluatePage(measure({}, [imageAlt, unusedJs]));
    expect(problems.map((p) => (p.kind === "failing_audit" ? p.auditId : p.kind))).toEqual([
      "image-alt",
      "unused-javascript",
    ]);
    expect(problems[0]).toMatchObject({ displayValue: "1 element", categories: ["accessibility"] });
  });
});

describe("acceptedValueCovers — the only place noise is tolerated", () => {
  it("deterministic values must not be any worse than accepted", () => {
    expect(acceptedValueCovers(92, 92, false)).toBe(true);
    expect(acceptedValueCovers(91, 92, false)).toBe(false);
  });

  it("noisy (Performance) values may fall within the tolerance of the accepted value", () => {
    expect(acceptedValueCovers(90 - ACCEPTED_PERFORMANCE_TOLERANCE, 90, true)).toBe(true);
    expect(acceptedValueCovers(90 - ACCEPTED_PERFORMANCE_TOLERANCE - 1, 90, true)).toBe(false);
  });

  it("the tolerance is small and explicit", () => {
    expect(ACCEPTED_PERFORMANCE_TOLERANCE).toBe(2);
  });
});

describe("lighthouseAcceptanceUpdates — accepted values only ratchet up", () => {
  const score = (key: QualityCategory, accepted: number): LighthouseAcceptance => ({
    id: `s-${key}`,
    kind: "score",
    key,
    accepted,
  });
  const finding = (key: string, accepted: number | null): LighthouseAcceptance => ({
    id: `f-${key}`,
    kind: "finding",
    key,
    accepted,
  });

  it("a deterministic category back at 100 spends its acceptance; a better score tightens it", () => {
    expect(
      lighthouseAcceptanceUpdates(
        [score("accessibility", 90), score("seo", 80)],
        measure({ seo: 85 }),
      ),
    ).toEqual([
      { id: "s-accessibility", action: "spend" },
      { id: "s-seo", action: "tighten", value: 85 },
    ]);
  });

  it("a worse or equal deterministic score leaves the acceptance (the gate blocks the worse one)", () => {
    expect(lighthouseAcceptanceUpdates([score("seo", 80)], measure({ seo: 75 }))).toEqual([]);
    expect(lighthouseAcceptanceUpdates([score("seo", 80)], measure({ seo: 80 }))).toEqual([]);
  });

  it("Performance acceptances never move automatically (noise)", () => {
    expect(
      lighthouseAcceptanceUpdates([score("performance", 80)], measure({ performance: 100 })),
    ).toEqual([]);
    expect(
      lighthouseAcceptanceUpdates([finding("unused-javascript", 20)], measure({}, [unusedJs])),
    ).toEqual([]);
  });

  it("a deterministic finding that still fails at a better score tightens its acceptance", () => {
    expect(
      lighthouseAcceptanceUpdates(
        [finding("uses-responsive-images", 40)],
        measure({}, [responsiveImages]),
      ),
    ).toEqual([{ id: "f-uses-responsive-images", action: "tighten", value: 60 }]);
  });

  it("a passing audit or a value-less (pre-0276) finding acceptance stays as recorded", () => {
    expect(lighthouseAcceptanceUpdates([finding("image-alt", 0)], measure({}))).toEqual([]);
    expect(
      lighthouseAcceptanceUpdates(
        [finding("uses-responsive-images", null)],
        measure({}, [responsiveImages]),
      ),
    ).toEqual([]);
  });
});

describe("medianScore", () => {
  it("takes the middle value (mean of the middle pair, rounded)", () => {
    expect(medianScore([90, 100, 80])).toBe(90);
    expect(medianScore([99])).toBe(99);
    expect(medianScore([97, 98])).toBe(98);
  });

  it("refuses an empty list", () => {
    expect(() => medianScore([])).toThrow(/no Performance runs/);
  });
});
