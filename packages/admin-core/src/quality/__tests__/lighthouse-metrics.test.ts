// SPDX-License-Identifier: MPL-2.0

/**
 * The Performance metrics extraction against a RECORDED Lighthouse 13.5
 * result: a full run and a Performance-only run of a small page whose LCP
 * is its heading and whose unsized hero image shifts the layout. Trimmed
 * to the fields Caelo reads (fixtures/lhr-performance-runs.json).
 */

import { describe, expect, it } from "bun:test";
import { type LhrLike, measurementFromRuns } from "../lighthouse-extract.js";
import {
  formatMetricValue,
  PERFORMANCE_METRICS,
  performanceMetricsFromRuns,
} from "../lighthouse-metrics.js";
import { pageMeasurementSchema, performanceMetricsSchema } from "../lighthouse-protocol.js";
import { recordedRuns } from "./fixtures/sample-metrics.js";

const [FULL, PERF_ONLY] = recordedRuns();

type Audit = LhrLike["audits"][string];

/** A copy of a run with some audits replaced (or removed with `null`). */
function withAudits(run: LhrLike, patch: Record<string, Partial<Audit> | null>): LhrLike {
  const audits: Record<string, Audit> = { ...run.audits };
  for (const [id, change] of Object.entries(patch)) {
    if (change === null) delete audits[id];
    else audits[id] = { ...(audits[id] as Audit), ...change };
  }
  return { ...run, audits };
}

function metric(m: ReturnType<typeof performanceMetricsFromRuns>, label: string) {
  const found = m.metrics.find((x) => x.label === label);
  if (!found) throw new Error(`no metric ${label}`);
  return found;
}

describe("performanceMetricsFromRuns (recorded Lighthouse 13.5 runs)", () => {
  it("reads every metric with value, unit, display value and score", () => {
    const m = performanceMetricsFromRuns([FULL], 0);
    expect(m.runs).toBe(1);
    expect(m.metrics.map((x) => x.id)).toEqual(PERFORMANCE_METRICS.map((d) => d.id));
    const lcp = metric(m, "LCP");
    expect(lcp).toEqual({
      id: "largest-contentful-paint",
      label: "LCP",
      title: "Largest Contentful Paint",
      numericUnit: "millisecond",
      numericValue: 2202,
      displayValue: "2.2 s",
      score: 0.95,
      runValues: [2202],
      unavailableReason: null,
    });
    const cls = metric(m, "CLS");
    expect(cls.numericUnit).toBe("unitless");
    expect(cls.numericValue).toBe(0.3558);
    expect(cls.displayValue).toBe("0.356");
    expect(cls.score).toBe(0.31);
    expect(metric(m, "TBT").numericValue).toBe(0);
    expect(metric(m, "TBT").displayValue).toBe("0 ms");
    expect(performanceMetricsSchema.safeParse(m).success).toBe(true);
  });

  it("formats each value like Lighthouse's own displayValue for a single run", () => {
    const m = performanceMetricsFromRuns([FULL], 0);
    for (const def of PERFORMANCE_METRICS) {
      const lighthouse = FULL.audits[def.id]?.displayValue?.replace(/ /g, " ");
      expect(metric(m, def.label).displayValue).toBe(lighthouse as string);
    }
  });

  it("names the LCP element and its breakdown from lcp-breakdown-insight", () => {
    const m = performanceMetricsFromRuns([FULL, PERF_ONLY], 0);
    expect(m.lcpElement).toEqual({ selector: "body > h1", snippet: "<h1>", label: "Hello" });
    expect(m.lcpBreakdown).toEqual([
      { subpart: "timeToFirstByte", label: "Time to first byte", durationMs: 2 },
      { subpart: "elementRenderDelay", label: "Element render delay", durationMs: 597 },
    ]);
  });

  it("lists the layout shifts with the element that moved and the root cause", () => {
    const m = performanceMetricsFromRuns([FULL], 0);
    expect(m.layoutShifts).toEqual([
      {
        element: { selector: "body", snippet: "<body>", label: "body" },
        score: 0.3558,
        causes: ["Media element lacking an explicit size: body > img.hero"],
      },
    ]);
  });

  it("reports the best run's values and keeps every run's value", () => {
    const slow = withAudits(PERF_ONLY, {
      "largest-contentful-paint": { numericValue: 5400, score: 0.2 },
      "total-blocking-time": { numericValue: 620, score: 0.45 },
    });
    const m = performanceMetricsFromRuns([slow, FULL, PERF_ONLY], 1);
    expect(m.runs).toBe(3);
    const lcp = metric(m, "LCP");
    expect(lcp.runValues).toEqual([5400, 2202, 2201]);
    expect(lcp.numericValue).toBe(2202);
    expect(lcp.score).toBe(0.95);
    const tbt = metric(m, "TBT");
    expect(tbt.runValues).toEqual([620, 0, 0]);
    expect(tbt.numericValue).toBe(0);
    expect(tbt.score).toBe(1);
  });

  it("takes the elements from the best run too", () => {
    const moved = withAudits(PERF_ONLY, { "lcp-breakdown-insight": null, "layout-shifts": null });
    const m = performanceMetricsFromRuns([FULL, moved], 1);
    expect(m.lcpElement).toBeNull();
    expect(m.layoutShifts).toEqual([]);
  });

  it("reports a metric the best run did not measure as null with the reason — never zero, never another run's value", () => {
    const errored = withAudits(PERF_ONLY, {
      "largest-contentful-paint": {
        score: null,
        scoreDisplayMode: "error",
        numericValue: undefined,
        errorMessage: "The page did not display content that qualifies as a LCP. (NO_LCP)",
      },
      "speed-index": null,
    });
    const m = performanceMetricsFromRuns([FULL, errored], 1);
    const lcp = metric(m, "LCP");
    expect(lcp.numericValue).toBeNull();
    expect(lcp.displayValue).toBeNull();
    expect(lcp.score).toBeNull();
    expect(lcp.runValues).toEqual([2202, null]);
    expect(lcp.unavailableReason).toContain("best of 2 Lighthouse run(s)");
    expect(lcp.unavailableReason).toContain("run 2: The page did not display content");
    const si = metric(m, "SI");
    expect(si.numericValue).toBeNull();
    expect(si.unavailableReason).toContain("run 2: Lighthouse returned no such audit");
    // The other metrics stay measured.
    expect(metric(m, "FCP").numericValue).toBe(2201);
    expect(performanceMetricsSchema.safeParse(m).success).toBe(true);
    // A run that is not the best one may miss a metric without hiding it.
    expect(metric(performanceMetricsFromRuns([FULL, errored], 0), "LCP").numericValue).toBe(2202);
  });

  it("is explicit when a run carries no metric audits at all", () => {
    const bare: LhrLike = { ...FULL, audits: {} };
    const m = performanceMetricsFromRuns([bare], 0);
    for (const x of m.metrics) {
      expect(x.numericValue).toBeNull();
      expect(x.unavailableReason).toContain("Lighthouse returned no such audit");
    }
    expect(m.lcpElement).toBeNull();
    expect(m.lcpBreakdown).toEqual([]);
    expect(m.layoutShifts).toEqual([]);
  });

  it("refuses a page without any run", () => {
    expect(() => performanceMetricsFromRuns([], 0)).toThrow(/no Lighthouse runs/);
    expect(() => performanceMetricsFromRuns([FULL], 1)).toThrow(/no run 2 of 1/);
  });

  it("rejects a metric that is neither measured nor explained", () => {
    const m = performanceMetricsFromRuns([FULL], 0);
    const broken = {
      ...m,
      metrics: m.metrics.map((x, i) => (i === 0 ? { ...x, numericValue: null } : x)),
    };
    expect(performanceMetricsSchema.safeParse(broken).success).toBe(false);
  });
});

describe("measurementFromRuns carries the metrics", () => {
  it("adds the metrics next to the scores without turning them into findings", () => {
    const { measurement, performanceRuns } = measurementFromRuns(FULL, [PERF_ONLY]);
    expect(performanceRuns).toEqual([79, 79]);
    expect(measurement.metrics.runs).toBe(2);
    expect(measurement.metrics.metrics.find((x) => x.label === "CLS")?.numericValue).toBe(0.3558);
    const ids = measurement.failingAudits.map((f) => f.id);
    for (const def of PERFORMANCE_METRICS) expect(ids).not.toContain(def.id);
    expect(pageMeasurementSchema.safeParse(measurement).success).toBe(true);
  });
});

describe("helpers", () => {
  it("formatMetricValue follows Lighthouse's units", () => {
    expect(formatMetricValue("largest-contentful-paint", 2449)).toBe("2.4 s");
    expect(formatMetricValue("total-blocking-time", 124)).toBe("120 ms");
    expect(formatMetricValue("cumulative-layout-shift", 0.0123)).toBe("0.012");
  });
});
