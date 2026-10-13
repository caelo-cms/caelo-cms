// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { formatPage } from "./quality-audit-tools.js";

type Page = Parameters<typeof formatPage>[0];

function page(problems: Page["problems"]): Page {
  return {
    pageId: "00000000-0000-0000-0000-000000000001",
    pageTitle: "Home",
    pagePath: "/",
    url: "http://localhost:8081/",
    status: "problems",
    scores: { "best-practices": 96 },
    baselines: { "best-practices": 100 },
    performanceRuns: [100],
    failingAudits: [],
    problems,
    heldBack: [],
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
      expect(line(id)).toContain("do not propose accepting it");
    }
    expect(line("uses-text-compression")).toContain("caused by this site");
    expect(line("image-alt")).not.toContain("CAELO PLATFORM");
    // The flagged resource is shown, as code, so the AI can tell whose file it is.
    expect(lines).toContain("  - flagged `http://localhost:8081/_assets/logo.png`");
  });
});
