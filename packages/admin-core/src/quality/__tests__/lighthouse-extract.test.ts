// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  bestRunIndex,
  categoryScores,
  failingAudits,
  type LhrLike,
  LighthouseRunError,
  measurementFromRuns,
} from "../lighthouse-extract.js";
import { pageMeasurementSchema } from "../lighthouse-protocol.js";

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
  // #727 "optimum, not good enough": a 0.95 is not a pass — every scored
  // audit below 1 is a finding (Lighthouse's own report shows >= 0.9 green).
  it("keeps every scored audit below 1 and tags every gated category referencing them", () => {
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
        id: "meta-description",
        title: "title of meta-description",
        score: 0.95,
        categories: ["seo"],
      },
      {
        id: "unused-javascript",
        title: "title of unused-javascript",
        score: 0.5,
        categories: ["performance"],
      },
    ]);
  });

  it("an audit at 0.99 is a finding; only a perfect score passes", () => {
    const run = lhr({
      performance: 100,
      audits: [audit("color-contrast", 0.99, "numeric"), audit("image-alt", 1)],
    });
    expect(failingAudits(run).map((f) => [f.id, f.score])).toEqual([["color-contrast", 0.99]]);
  });

  it("informative, manual and not-applicable audits never become findings", () => {
    const run = lhr({
      performance: 100,
      audits: [
        audit("image-alt", 0, "informative"),
        audit("color-contrast", 0, "manual"),
        audit("meta-description", 0, "notApplicable"),
      ],
    });
    expect(failingAudits(run)).toEqual([]);
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

describe("flagged elements", () => {
  it("carry Lighthouse's node selector, snippet, label and explanation (first 5)", () => {
    const contrast: Audit = {
      ...audit("color-contrast", 0),
      details: {
        items: [
          ...Array.from({ length: 6 }, (_v, i) => ({
            node: {
              type: "node",
              selector: `header > a.cta-${i}`,
              snippet: `<a class="cta-${i}">`,
              nodeLabel: "Get started",
              explanation:
                "Fix any of the following: Element has insufficient color contrast of 2.9 (foreground color: #ffffff, background color: #8b8bf5)",
            },
          })),
          { url: "https://s/no-node.css" },
        ],
      },
    };
    const [finding] = failingAudits(lhr({ performance: 100, audits: [contrast] }));
    // Five kept, then a marker that the list is a sample (#667).
    expect(finding?.elements).toHaveLength(6);
    expect(finding?.elements?.[5]).toEqual({ label: "+2 more flagged item(s) not shown" });
    expect(finding?.elements?.[0]).toEqual({
      selector: "header > a.cta-0",
      snippet: '<a class="cta-0">',
      label: "Get started",
      explanation:
        "Fix any of the following: Element has insufficient color contrast of 2.9 (foreground color: #ffffff, background color: #8b8bf5)",
    });
  });

  it("pass the wire schema when the list is truncated", () => {
    // The "+N more" marker made a sixth entry the protocol schema (max 5)
    // rejected — and one rejected finding failed the whole audit run.
    const contrast: Audit = {
      ...audit("color-contrast", 0),
      details: {
        items: Array.from({ length: 12 }, (_v, i) => ({
          node: { type: "node", selector: `p.low-${i}`, snippet: `<p class="low-${i}">` },
        })),
      },
    };
    const { measurement } = measurementFromRuns(
      lhr({ performance: 100, accessibility: 90, audits: [contrast] }),
      [],
    );
    expect(measurement.failingAudits[0]?.elements).toHaveLength(6);
    const parsed = pageMeasurementSchema.safeParse(measurement);
    expect(parsed.error).toBeUndefined();
  });

  it("carry an errors-in-console entry's message and the URL it came from", () => {
    // PR #641's homepage run: the finding said only "Browser errors were
    // logged to the console", the AI blamed a plugin's runtime for what was
    // a /favicon.ico 404, and built a cookie banner to "fix" it.
    const consoleErrors: Audit = {
      ...audit("errors-in-console", 0),
      details: {
        items: [
          {
            source: "network",
            description:
              "Failed to load resource: the server responded with a status of 404 (Not Found)",
            sourceLocation: { type: "source-location", url: "http://localhost:8081/favicon.ico" },
          },
          { source: "exception", description: "TypeError: x is undefined" },
          { source: "console.error" },
        ],
      },
    };
    const [finding] = failingAudits(lhr({ performance: 100, audits: [consoleErrors] }));
    expect(finding?.elements).toEqual([
      {
        explanation:
          "network: Failed to load resource: the server responded with a status of 404 (Not Found)",
        url: "http://localhost:8081/favicon.ico",
      },
      { explanation: "exception: TypeError: x is undefined" },
    ]);
  });

  it("carry the URLs and reasons of resource / bf-cache audits (#667)", () => {
    // Without them the AI could not tell Caelo's own files from a module's
    // third-party embed, guessed "hosting", and argued for acceptance.
    // (Ids the fixture's categories reference; the extraction is per item shape.)
    const cache: Audit = {
      ...audit("unused-javascript", 0),
      details: {
        items: [{ url: "http://localhost:8081/_assets/logo.png", cacheLifetimeMs: 3600000 }],
      },
    };
    const bf: Audit = {
      ...audit("render-blocking-insight", 0),
      details: {
        items: [
          {
            reason: "The page has an unload handler in the main frame.",
            failureType: "Actionable",
          },
        ],
      },
    };
    const found = failingAudits(lhr({ performance: 100, audits: [cache, bf] }));
    const c = found.find((f) => f.id === "unused-javascript");
    const b = found.find((f) => f.id === "render-blocking-insight");
    expect(c?.elements).toEqual([{ url: "http://localhost:8081/_assets/logo.png" }]);
    expect(b?.elements).toEqual([
      { explanation: "The page has an unload handler in the main frame." },
    ]);
  });

  it("are omitted when the audit names no element", () => {
    const [finding] = failingAudits(lhr({ performance: 100, audits: [audit("image-alt", 0)] }));
    expect(finding && "elements" in finding).toBe(false);
  });
});

describe("staging-exempt audits", () => {
  // Staging is noindex by design, so `is-crawlable` fails on every staged
  // page (seen in the e2e-livedit run: SEO 58 from that audit alone).
  const staged: LhrLike = {
    requestedUrl: "http://localhost:8081/",
    categories: {
      seo: {
        score: 0.58,
        auditRefs: [
          { id: "is-crawlable", weight: 4.043 },
          { id: "meta-description", weight: 1 },
          { id: "document-title", weight: 1 },
          { id: "hreflang", weight: 0 },
        ],
      },
    },
    audits: {
      "is-crawlable": audit("is-crawlable", 0),
      "meta-description": audit("meta-description", 0),
      "document-title": audit("document-title", 1),
      hreflang: audit("hreflang", null, "notApplicable"),
    },
  };

  it("are no finding", () => {
    expect(failingAudits(staged).map((f) => f.id)).toEqual(["meta-description"]);
  });

  it("are taken out of the category score (weighted mean of the rest)", () => {
    expect(categoryScores(staged, ["seo"]).seo).toBe(50);
  });

  it("leave categories without them untouched", () => {
    const clean: LhrLike = {
      ...staged,
      categories: { seo: { score: 0.92, auditRefs: [{ id: "document-title", weight: 1 }] } },
    };
    expect(categoryScores(clean, ["seo"]).seo).toBe(92);
  });
});

describe("measurementFromRuns", () => {
  it("scores Performance by the best run and takes its Performance-only findings", () => {
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
      audits: [audit("unused-javascript", 0.5, "metricSavings")],
    });
    const { measurement, performanceRuns } = measurementFromRuns(full, [second, third]);
    expect(performanceRuns).toEqual([80, 95, 90]);
    expect(measurement.scores).toEqual({
      performance: 95,
      accessibility: 92,
      "best-practices": 100,
      seo: 100,
    });
    // unused-javascript passes in the best run; image-alt is an
    // Accessibility finding and always comes from the full run.
    expect(measurement.failingAudits.map((f) => f.id)).toEqual(["image-alt"]);
  });

  it("is stable on the bimodal runs of an unchanged page (#837)", () => {
    // /migrate on caelo-cms.com, byte-identical between two audits: TBT
    // 0 / 451 / 258 ms in one, 0 / 600 / 516 ms in the next. The median
    // moved the score 99 → 89; the best run scores 100 both times.
    const tbt = audit("total-blocking-time", 0.4, "numeric");
    const audits = [
      lhr({ performance: 100, audits: [] }),
      lhr({ performance: 91, perfOnly: true, audits: [tbt] }),
      lhr({ performance: 94, perfOnly: true, audits: [tbt] }),
    ];
    const next = [
      lhr({ performance: 89, audits: [tbt] }),
      lhr({ performance: 100, perfOnly: true, audits: [] }),
      lhr({ performance: 87, perfOnly: true, audits: [tbt] }),
    ];
    const [a0, ...aRest] = audits;
    const [n0, ...nRest] = next;
    const first = measurementFromRuns(a0 as LhrLike, aRest);
    const second = measurementFromRuns(n0 as LhrLike, nRest);
    expect(first.measurement.scores.performance).toBe(100);
    expect(second.measurement.scores.performance).toBe(100);
    expect(first.measurement.failingAudits).toEqual(second.measurement.failingAudits);
  });

  it("breaks a tie by the fewest Performance-only findings, then the earliest run", () => {
    const failing = audit("unused-javascript", 0.3, "metricSavings");
    const full = lhr({ performance: 100, audits: [failing] });
    const r2 = lhr({
      performance: 100,
      perfOnly: true,
      audits: [audit("unused-javascript", 1, "metricSavings")],
    });
    const r3 = lhr({ performance: 100, perfOnly: true, audits: [] });
    const { measurement } = measurementFromRuns(full, [r2, r3]);
    expect(measurement.failingAudits).toEqual([]);
    expect(bestRunIndex([100, 100, 100], [1, 0, 0])).toBe(1);
    expect(bestRunIndex([98, 100, 100], [0, 0, 0])).toBe(1);
  });

  it("keeps a Performance-only finding that fails in the best run", () => {
    const failing = audit("unused-javascript", 0.3, "metricSavings");
    const full = lhr({ performance: 97, audits: [failing] });
    const r2 = lhr({ performance: 96, perfOnly: true, audits: [] });
    const { measurement } = measurementFromRuns(full, [r2]);
    expect(measurement.scores.performance).toBe(97);
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

  it("refuses a page without runs", () => {
    expect(() => bestRunIndex([], [])).toThrow(/no Performance runs/);
  });

  it("refuses score and finding lists of different runs", () => {
    expect(() => bestRunIndex([100, 99], [0])).toThrow(/2 Performance score\(s\) but 1/);
  });

  it("lists an audit shared with another category once, even when the best run is Performance-only", () => {
    // An extra run carries only the Performance category, so an audit that
    // Performance shares with Best Practices looks Performance-only there.
    // Its category comes from the full run, and it is listed once.
    const withShared = (run: LhrLike): LhrLike => {
      const categories = { ...run.categories };
      for (const c of ["performance", "best-practices"] as const) {
        const cat = categories[c];
        if (cat) categories[c] = { ...cat, auditRefs: [...cat.auditRefs, { id: "shared-audit" }] };
      }
      return { ...run, categories };
    };
    const shared = audit("shared-audit", 0);
    const full = withShared(lhr({ performance: 90, bestPractices: 92, audits: [shared] }));
    const best = withShared(lhr({ performance: 100, perfOnly: true, audits: [shared] }));
    const { measurement } = measurementFromRuns(full, [best]);
    expect(measurement.scores.performance).toBe(100);
    const found = measurement.failingAudits.filter((f) => f.id === "shared-audit");
    expect(found).toHaveLength(1);
    expect(found[0]?.categories).toEqual(["performance", "best-practices"]);
  });
});
