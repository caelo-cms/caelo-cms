// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { sampleMetrics } from "../../quality/__tests__/fixtures/sample-metrics.js";
import { ACCEPTED_PERFORMANCE_TOLERANCE } from "../../quality/ratchet.js";
import {
  AUDIT_FIX_LOOP_NEXT_STEP,
  formatAudit,
  formatPage,
  readStageAudit,
  readUntilSettled,
} from "./quality-audit-tools.js";

type Page = Parameters<typeof formatPage>[0];

function page(problems: Page["problems"]): Page {
  return {
    pageId: "00000000-0000-0000-0000-000000000001",
    pageTitle: "Home",
    pagePath: "/",
    url: "http://localhost:8081/",
    status: "problems",
    scores: { "best-practices": 96 },
    previousScores: null,
    performanceRuns: [100],
    failingAudits: [],
    metrics: null,
    problems,
    problemAccepted: problems.map(() => false),
    checkFindings: [],
    errorCode: null,
    errorMessage: null,
  };
}

describe("get_quality_audit page formatting", () => {
  it("names the console entry behind errors-in-console, URL as code", () => {
    // Regression (PR #641 homepage run): without the message + URL the AI
    // guessed the cause of a /favicon.ico 404 and changed the wrong thing.
    const lines = formatPage(
      page([
        {
          kind: "failing_audit",
          auditId: "errors-in-console",
          title: "Browser errors were logged to the console",
          score: 0,
          categories: ["best-practices"],
          elements: [
            {
              explanation:
                "network: Failed to load resource: the server responded with a status of 404 (Not Found)",
              url: "http://localhost:8081/favicon.ico",
            },
          ],
        },
      ]),
    );
    expect(lines).toContain(
      "  - console `http://localhost:8081/favicon.ico` — network: Failed to load resource: the server responded with a status of 404 (Not Found)",
    );
  });

  it("keeps flagged elements as elements", () => {
    const lines = formatPage(
      page([
        {
          kind: "failing_audit",
          auditId: "color-contrast",
          title: "Background and foreground colors do not have a sufficient contrast ratio.",
          score: 0,
          categories: ["accessibility"],
          elements: [{ selector: "header > a.cta", explanation: "contrast of 2.9" }],
        },
      ]),
    );
    expect(lines).toContain("  - element `header > a.cta` — contrast of 2.9");
  });

  it("marks findings by the evidence: Caelo platform vs. the site's own code (#667)", () => {
    const audit = (auditId: string, elements: { explanation?: string; url?: string }[]) => ({
      kind: "failing_audit" as const,
      auditId,
      title: auditId,
      score: 0,
      categories: ["performance" as const],
      elements,
    });
    const lines = formatPage(
      page([
        audit("bf-cache", [{ explanation: "Back/forward cache is disabled by flags." }]),
        audit("cache-insight", [{ url: "http://localhost:8081/_assets/logo.png" }]),
        audit("uses-text-compression", [{ url: "https://cdn.example.net/widget.js" }]),
        audit("server-response-time", []),
        { ...audit("image-alt", []), categories: ["accessibility" as const] },
      ]),
    );
    const line = (id: string) => lines.find((l) => l.includes(`\`${id}\``)) ?? "";
    for (const id of ["bf-cache", "cache-insight", "server-response-time"]) {
      expect(line(id)).toContain("CAELO PLATFORM: decided by Caelo's hosting");
      expect(line(id)).toContain("never recommend it");
    }
    expect(line("uses-text-compression")).toContain("caused by this site");
    expect(line("image-alt")).not.toContain("CAELO PLATFORM");
    // The flagged resource is shown, as code, so the AI can tell whose file it is.
    expect(lines).toContain("  - flagged `http://localhost:8081/_assets/logo.png`");
  });
});

describe("get_quality_audit Performance metrics", () => {
  it("shows each metric with its rating, the LCP element and the layout shifts", () => {
    const lines = formatPage({ ...page([]), status: "clean", metrics: sampleMetrics() });
    expect(lines).toContain(
      "Performance metrics (best of 1 Lighthouse run(s) on the staged build; data behind the Performance score, not problems):",
    );
    expect(lines).toContain("- LCP 2.2 s (Largest Contentful Paint) — score 0.95, good");
    expect(lines).toContain("- CLS 0.356 (Cumulative Layout Shift) — score 0.31, POOR");
    expect(lines).toContain("- LCP element: `body > h1` `<h1>` (Hello)");
    expect(lines).toContain(
      "- LCP breakdown: Time to first byte 2 ms, Element render delay 597 ms",
    );
    expect(lines).toContain(
      "- layout shift 0.3558: `body` `<body>` (body) — causes: Media element lacking an explicit size: body > img.hero",
    );
  });

  it("says why a metric is missing instead of printing a value", () => {
    const m = sampleMetrics();
    const metrics = {
      ...m,
      metrics: m.metrics.map((x) =>
        x.label === "LCP"
          ? {
              ...x,
              numericValue: null,
              displayValue: null,
              score: null,
              runValues: [null],
              unavailableReason: "LCP was not measured in 1 of 1 Lighthouse run(s) (run 1: NO_LCP)",
            }
          : x,
      ),
    };
    const lines = formatPage({ ...page([]), status: "clean", metrics });
    expect(lines).toContain(
      "- LCP (Largest Contentful Paint) not measured: LCP was not measured in 1 of 1 Lighthouse run(s) (run 1: NO_LCP)",
    );
  });

  it("omits the block for a page Lighthouse did not audit", () => {
    expect(formatPage(page([])).some((l) => l.startsWith("Performance metrics"))).toBe(false);
  });

  it("points out a score drop against the page's previous audit, without claiming its cause", () => {
    const drop = {
      kind: "score_below_baseline" as const,
      category: "performance" as const,
      score: 92,
      baseline: 100,
    };
    const dropped = formatPage({ ...page([drop]), previousScores: { performance: 97 } }).join("\n");
    expect(dropped).toContain(
      "DROPPED since this page's previous audit (97 → 92): check the changes since then first",
    );
    expect(dropped).not.toContain("caused");
    const better = formatPage({ ...page([drop]), previousScores: { performance: 90 } });
    expect(better.join("\n")).not.toContain("DROPPED");
    expect(formatPage(page([drop])).join("\n")).not.toContain("DROPPED");
  });

  it("holds a Performance drop within the documented noise tolerance back from the hint only", () => {
    const at = (category: "performance" | "accessibility", score: number) => ({
      kind: "score_below_baseline" as const,
      category,
      score,
      baseline: 100,
    });
    const withinNoise = 100 - ACCEPTED_PERFORMANCE_TOLERANCE;
    const noisy = formatPage({
      ...page([at("performance", withinNoise)]),
      previousScores: { performance: 100 },
    }).join("\n");
    expect(noisy).not.toContain("DROPPED");
    // The score itself is still a problem: the tolerance never applies
    // against the target.
    expect(noisy).toContain(`PROBLEM Performance score ${withinNoise} is below the target 100`);
    const beyond = formatPage({
      ...page([at("performance", withinNoise - 1)]),
      previousScores: { performance: 100 },
    }).join("\n");
    expect(beyond).toContain(`DROPPED since this page's previous audit (100 → ${withinNoise - 1})`);
    // Accessibility is deterministic: one point is a drop.
    const a11y = formatPage({
      ...page([at("accessibility", 99)]),
      previousScores: { accessibility: 100 },
    }).join("\n");
    expect(a11y).toContain("DROPPED since this page's previous audit (100 → 99)");
  });
});

describe("get_quality_audit result", () => {
  function auditValue(status: string, problemAccepted: boolean[]) {
    return {
      run: {
        id: "r1",
        deployRunId: "d1",
        status,
        problemCount: problemAccepted.length,
        classification: { auditNeeded: false, reasons: [], skipped: [] },
      },
      pages: [{ ...page([]), problemAccepted, problems: [] }],
      checks: null,
      siteProblemAccepted: [],
    };
  }
  it("ends with the fix-loop instruction while a problem is open", () => {
    // An external agent read 92–97, reported the scores and stopped.
    const v = auditValue("problems", [false]);
    expect(formatAudit(v)).toContain(AUDIT_FIX_LOOP_NEXT_STEP);
    expect(formatAudit(auditValue("problems", [true]))).not.toContain(AUDIT_FIX_LOOP_NEXT_STEP);
    expect(formatAudit(auditValue("passed", []))).not.toContain(AUDIT_FIX_LOOP_NEXT_STEP);
  });

  // e2e-livedit detected bug: the AI called get_quality_audit({pageId}) —
  // its sibling list_quality_acceptances takes one — and was refused.
  it("narrows the per-page sections to `pageId`, keeping the run summary", () => {
    const about = {
      ...page([]),
      pageId: "00000000-0000-0000-0000-000000000002",
      pageTitle: "About",
      pagePath: "/about",
    };
    const v = { ...auditValue("problems", []), pages: [page([]), about] };
    const out = formatAudit(v, { pageId: about.pageId });
    expect(out).toContain("audit r1 (deploy run d1)");
    expect(out).toContain("## About (/about)");
    expect(out).not.toContain("## Home (/)");
    expect(formatAudit(v)).toContain("## Home (/)");
  });

  it("says loudly when the audit has no result for `pageId`", () => {
    const out = formatAudit(auditValue("passed", []), {
      pageId: "00000000-0000-0000-0000-000000000009",
    });
    expect(out).toContain("has no result for page 00000000-0000-0000-0000-000000000009");
    expect(out).toContain("/ (00000000-0000-0000-0000-000000000001)");
  });
});

describe("readUntilSettled", () => {
  const settled = { ok: true, value: { run: { status: "problems" } } };
  const running = { ok: true, value: { run: { status: "running" } } };

  it("re-reads a running audit until it settles", async () => {
    const reads = [running, running, settled];
    let clock = 0;
    const r = await readUntilSettled(async () => reads.shift() ?? settled, {
      waitMs: 50_000,
      intervalMs: 5_000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r).toBe(settled);
    expect(clock).toBe(10_000);
  });

  it("gives up at the deadline and returns the running read", async () => {
    let clock = 0;
    let reads = 0;
    const r = await readUntilSettled(
      async () => {
        reads += 1;
        return running;
      },
      {
        waitMs: 12_000,
        intervalMs: 5_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(r).toBe(running);
    expect(reads).toBe(4);
  });

  it("stops waiting when the turn is stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    await readUntilSettled(
      async () => {
        reads += 1;
        return running;
      },
      { waitMs: 50_000, intervalMs: 5_000, signal: controller.signal, sleep: async () => {} },
    );
    expect(reads).toBe(1);
  });
});

describe("readStageAudit", () => {
  const running = { ok: true, value: { run: { status: "running" } } };
  const noAudit = { ok: true, value: { run: null } };

  it("waits for the build and the audit within one budget (#1211)", async () => {
    let clock = 0;
    const r = await readStageAudit(
      {
        runId: "00000000-0000-0000-0000-000000001211",
        // The build is done after 30 s; its audit then keeps running.
        readRun: async () => ({
          status: clock >= 30_000 ? "succeeded" : "running",
          errorMessage: null,
          progress: null,
        }),
        read: async () => (clock >= 30_000 ? running : noAudit),
      },
      {
        waitMs: 50_000,
        intervalMs: 5_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(r).toBe(running);
    // Not 30 s for the build plus a fresh 50 s for the audit.
    expect(clock).toBeLessThanOrEqual(50_000);
  });
});
