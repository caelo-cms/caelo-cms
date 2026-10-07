// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  categoryScores,
  failingAudits,
  type LhrLike,
  LighthouseRunError,
  measurementFromRuns,
} from "../lighthouse-extract.js";

type Audit = LhrLike["audits"][string];

function audit(id: string, score: number | null, mode = "binary", displayValue?: string): Audit {
  return {
    id,
    title: `title of ${id}`,
    score,
    scoreDisplayMode: mode,
    ...(displayValue ? { displayValue } : {}),
  };
}

/** A small LHR shaped like Lighthouse 13 output (categories + auditRefs). */
function lhr(opts: {
  performance: number;
  accessibility?: number;
  bestPractices?: number;
  seo?: number;
  audits: Audit[];
  perfOnly?: boolean;
}): LhrLike {
  const audits = Object.fromEntries(opts.audits.map((a) => [a.id, a]));
  const perf = {
    score: opts.performance / 100,
    auditRefs: [
      { id: "largest-contentful-paint", group: "metrics" },
      { id: "unused-javascript" },
      { id: "render-blocking-insight", group: "insights" },
      { id: "screenshot-thumbnails", group: "hidden" },
    ],
  };
  if (opts.perfOnly)
    return { requestedUrl: "https://s/", categories: { performance: perf }, audits };
  return {
    requestedUrl: "https://s/",
    finalDisplayedUrl: "https://s/",
    categories: {
      performance: perf,
      accessibility: {
        score: (opts.accessibility ?? 100) / 100,
        auditRefs: [{ id: "image-alt", group: "a11y-names-labels" }, { id: "color-contrast" }],
      },
      "best-practices": {
        score: (opts.bestPractices ?? 100) / 100,
        auditRefs: [{ id: "errors-in-console" }],
      },
      seo: {
        score: (opts.seo ?? 100) / 100,
        auditRefs: [{ id: "meta-description" }, { id: "image-alt" }],
      },
    },
    audits,
  };
}

describe("failingAudits", () => {
  it("keeps scored audits below 0.9 and tags every gated category referencing them", () => {
    const run = lhr({
      performance: 90,
      audits: [
        audit("image-alt", 0, "binary", "1 element"),
        audit("color-contrast", 1),
        audit("meta-description", 0.95, "numeric"),
        audit("unused-javascript", 0.5, "metricSavings"),
        audit("errors-in-console", null, "error"),
        audit("largest-contentful-paint", 0.2, "numeric"),
        audit("screenshot-thumbnails", 0, "informative"),
        audit("render-blocking-insight", 0, "informative"),
      ],
    });
    expect(failingAudits(run)).toEqual([
      {
        id: "image-alt",
        title: "title of image-alt",
        score: 0,
        categories: ["accessibility", "seo"],
        displayValue: "1 element",
      },
      {
        id: "unused-javascript",
        title: "title of unused-javascript",
        score: 0.5,
        categories: ["performance"],
      },
    ]);
  });

  it("a Lighthouse runtime error is an infrastructure failure, not a score", () => {
    const run: LhrLike = {
      ...lhr({ performance: 0, audits: [] }),
      runtimeError: { code: "ERRORED_DOCUMENT_REQUEST", message: "status code 404" },
    };
    expect(() => failingAudits(run)).toThrow(LighthouseRunError);
    expect(() => categoryScores(run, ["seo"])).toThrow(/404/);
  });

  it("refuses a missing category score", () => {
    const run = lhr({ performance: 90, audits: [], perfOnly: true });
    expect(() => categoryScores(run, ["seo"])).toThrow(/no seo score/);
  });
});

describe("measurementFromRuns", () => {
  it("uses the Performance median and majority-filters Performance-only findings", () => {
    const full = lhr({
      performance: 80,
      accessibility: 92,
      audits: [audit("image-alt", 0), audit("unused-javascript", 0.4, "metricSavings")],
    });
    const second = lhr({
      performance: 95,
      perfOnly: true,
      audits: [audit("unused-javascript", 1, "metricSavings")],
    });
    const third = lhr({
      performance: 90,
      perfOnly: true,
      audits: [audit("unused-javascript", 1, "metricSavings")],
    });
    const { measurement, performanceRuns } = measurementFromRuns(full, [second, third]);
    expect(performanceRuns).toEqual([80, 95, 90]);
    expect(measurement.scores).toEqual({
      performance: 90,
      accessibility: 92,
      "best-practices": 100,
      seo: 100,
    });
    // unused-javascript failed in 1 of 3 runs → jitter, dropped.
    expect(measurement.failingAudits.map((f) => f.id)).toEqual(["image-alt"]);
  });

  it("keeps a Performance-only finding that fails in most runs, even if not in the first", () => {
    const failing = audit("unused-javascript", 0.3, "metricSavings");
    const full = lhr({
      performance: 100,
      audits: [audit("unused-javascript", 1, "metricSavings")],
    });
    const r2 = lhr({ performance: 100, perfOnly: true, audits: [failing] });
    const r3 = lhr({ performance: 100, perfOnly: true, audits: [failing] });
    const { measurement } = measurementFromRuns(full, [r2, r3]);
    expect(measurement.failingAudits.map((f) => f.id)).toEqual(["unused-javascript"]);
  });

  it("works with a single run", () => {
    const { measurement, performanceRuns } = measurementFromRuns(
      lhr({ performance: 99, audits: [] }),
      [],
    );
    expect(performanceRuns).toEqual([99]);
    expect(measurement.scores.performance).toBe(99);
  });
});
