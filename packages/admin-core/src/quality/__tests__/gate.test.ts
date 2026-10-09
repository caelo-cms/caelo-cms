// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { chatFeedbackFor, MAX_AUTO_FIX_ROUNDS } from "../chat-feedback.js";
import { decideGate, findingKey, type GateAudit, scoreKey } from "../gate.js";

const NONE = { findings: new Set<string>(), scores: new Map<string, number>() };

function audit(over: Partial<GateAudit> = {}): GateAudit {
  return {
    id: "a1",
    status: "passed",
    errorCode: null,
    errorMessage: null,
    publishOverride: null,
    pages: [],
    ...over,
  };
}

const problems: GateAudit["pages"] = [
  {
    pageId: "p-about",
    pagePath: "/about",
    problems: [
      {
        kind: "failing_audit",
        auditId: "color-contrast",
        title: "contrast",
        score: 0,
        categories: ["accessibility"],
      },
      { kind: "score_below_baseline", category: "accessibility", score: 92, baseline: 100 },
    ],
  },
];

describe("decideGate", () => {
  it("passed and skipped audits open the gate", () => {
    expect(decideGate(audit(), NONE)).toMatchObject({ open: true, state: "clean" });
    expect(decideGate(audit({ status: "skipped" }), NONE)).toMatchObject({ open: true });
  });

  it("no audit, a superseded one, or one still running blocks", () => {
    expect(decideGate(null, NONE)).toMatchObject({ open: false, state: "missing" });
    expect(decideGate(audit({ status: "superseded" }), NONE).state).toBe("missing");
    for (const status of ["queued", "running"] as const) {
      expect(decideGate(audit({ status }), NONE)).toMatchObject({ open: false, state: "running" });
    }
  });

  it("problems block with every open problem named and the next step", () => {
    const d = decideGate(audit({ status: "problems", pages: problems }), NONE);
    expect(d).toMatchObject({ open: false, state: "problems", canPublishAnyway: false });
    expect(d.openProblems).toHaveLength(2);
    expect(d.message).toContain("/about: color-contrast");
    expect(d.message).toContain("accept_quality_findings");
  });

  it("acceptances on the page clear their problems; partially accepted still blocks", () => {
    const finding = new Set([findingKey("p-about", "color-contrast")]);
    const partial = decideGate(audit({ status: "problems", pages: problems }), {
      findings: finding,
      scores: new Map(),
    });
    expect(partial).toMatchObject({ open: false, state: "problems" });
    expect(partial.openProblems).toHaveLength(1);
    const all = decideGate(audit({ status: "problems", pages: problems }), {
      findings: finding,
      scores: new Map([[scoreKey("p-about", "accessibility"), 92]]),
    });
    expect(all).toMatchObject({ open: true, state: "accepted" });
  });

  it("an accepted score only covers that score or better", () => {
    const d = decideGate(audit({ status: "problems", pages: problems }), {
      findings: new Set([findingKey("p-about", "color-contrast")]),
      scores: new Map([[scoreKey("p-about", "accessibility"), 95]]),
    });
    expect(d.open).toBe(false);
  });

  it("an acceptance never covers another page", () => {
    const d = decideGate(audit({ status: "problems", pages: problems }), {
      findings: new Set([findingKey("p-home", "color-contrast")]),
      scores: new Map([[scoreKey("p-home", "accessibility"), 50]]),
    });
    expect(d.openProblems).toHaveLength(2);
  });

  it("a failed audit blocks but offers publish anyway; the override opens it", () => {
    const failed = audit({ status: "errored", errorCode: "timeout", errorMessage: "too slow" });
    expect(decideGate(failed, NONE)).toMatchObject({
      open: false,
      state: "errored",
      canPublishAnyway: true,
    });
    expect(decideGate(failed, NONE).message).toContain("timeout: too slow");
    expect(
      decideGate({ ...failed, publishOverride: { by: "u1", reason: "deadline" } }, NONE),
    ).toMatchObject({ open: true, state: "overridden", canPublishAnyway: false });
  });
});

describe("chatFeedbackFor", () => {
  const base = {
    fixRound: 0,
    problemCount: 0,
    problemPagePaths: [] as string[],
    errorCode: null,
    errorMessage: null,
    skippedBecause: [] as string[],
  };

  it("stays silent while the audit runs", () => {
    for (const status of ["queued", "running", "superseded"] as const) {
      expect(chatFeedbackFor({ ...base, status })).toBeNull();
    }
  });

  it("passed / skipped / failed are status notes, not AI turns", () => {
    expect(chatFeedbackFor({ ...base, status: "passed" })?.kind).toBe("note");
    expect(
      chatFeedbackFor({ ...base, status: "skipped", skippedBecause: ["field values: hero"] })?.text,
    ).toContain("field values: hero");
    const failed = chatFeedbackFor({
      ...base,
      status: "errored",
      errorCode: "timeout",
      errorMessage: "Lighthouse audit exceeded 210 s",
    });
    expect(failed).toEqual({
      kind: "note",
      text: expect.stringContaining("Quality check failed: Lighthouse audit exceeded 210 s"),
    });
  });

  it("problems start an AI fix round until the cap, then ask for acceptances only", () => {
    const at = (fixRound: number) =>
      chatFeedbackFor({
        ...base,
        status: "problems",
        fixRound,
        problemCount: 3,
        problemPagePaths: ["/", "/a", "/b", "/c", "/d"],
      });
    expect(at(0)).toMatchObject({ kind: "ai-turn" });
    expect(at(0)?.text).toContain("Fix round 1 of 2");
    expect(at(0)?.text).toContain("/, /a, /b, /c and 1 more");
    expect(at(1)?.text).toContain("Fix round 2 of 2");
    // Issue #620 — the AI stages its own fixes; a "ask me to Stage" here
    // taught it the operator stages, and it stopped staging later work
    // (PR #624 real-AI homepage run).
    expect(at(0)?.text).toContain("Stage again yourself (stage_changes)");
    expect(at(0)?.text).not.toContain("ask me to Stage");
    expect(at(MAX_AUTO_FIX_ROUNDS)?.text).toContain("Do not change the site further");
    expect(at(MAX_AUTO_FIX_ROUNDS)?.text).toContain("accept_quality_findings");
  });
});
