// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type ChatAuditSummary,
  type ChatFeedback,
  type ChatProblemPage,
  chatFeedbackFor,
  MAX_AUTO_FIX_ROUNDS,
  problemLabel,
} from "../chat-feedback.js";
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
    // #667 — acceptance is the editor's call, never the AI's suggestion.
    expect(d.message).toContain("only on the editor's explicit request");
    expect(d.message).not.toContain("have an editor accept");
    expect(d.message).toContain("bug_report");
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
    problemPages: [] as ChatProblemPage[],
    stagedBy: null,
    errorCode: null,
    errorMessage: null,
    skippedBecause: [] as string[],
  };
  const fivePages: ChatProblemPage[] = [
    { path: "/", findings: ["Low contrast", "Image without alt", "Missing label"] },
    { path: "/a", findings: ["accessibility score 92 (was 100)"] },
    { path: "/b", findings: ["Missing meta description"] },
    { path: "/c", findings: ["Render-blocking CSS"] },
    { path: "/d", findings: ["Image too large"] },
  ];
  type Offer = Extract<ChatFeedback, { kind: "offer" }>;
  const offer = (over: Partial<ChatAuditSummary> = {}): Offer => {
    const f = chatFeedbackFor({
      ...base,
      status: "problems",
      problemCount: 7,
      problemPages: fivePages,
      ...over,
    });
    if (f?.kind !== "offer") throw new Error(`expected an offer, got ${JSON.stringify(f)}`);
    return f;
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

  it("problems are an offer the operator answers — for every origin of the Stage (#685)", () => {
    for (const stagedBy of ["operator", "live_edit_ai", "other_agent", null] as const) {
      const f = offer({ stagedBy });
      expect(f.kind).toBe("offer");
      expect(f.actionLabel).toBe("Fix with AI");
      expect(f.text).toContain("Quality check found 7 issue(s) on 5 page(s)");
      expect(f.text).toContain("Let the AI fix them?");
    }
  });

  it("the card names the pages with their first findings, briefly", () => {
    const f = offer();
    expect(f.text).toContain("/ (Low contrast, Image without alt +1)");
    expect(f.text).toContain("/a (accessibility score 92 (was 100))");
    expect(f.text).toContain("and 2 more page(s)");
    expect(f.text).not.toContain("/d");
  });

  it("the card and the prompt say who staged", () => {
    expect(offer({ stagedBy: "operator" }).text).toContain("Staged by you.");
    expect(offer({ stagedBy: "operator" }).prompt).toContain("I staged this build myself");
    expect(offer({ stagedBy: "live_edit_ai" }).prompt).toContain(
      "You staged this build with stage_changes in an earlier turn",
    );
    expect(offer({ stagedBy: "other_agent" }).prompt).toContain("Another agent staged this build");
    expect(offer({ stagedBy: null }).prompt).toContain("not recorded who staged");
  });

  it("the prompt carries every finding per page and the 'not only your changes' note", () => {
    const { prompt } = offer({ stagedBy: "operator" });
    for (const p of fivePages) {
      for (const finding of p.findings) expect(prompt).toContain(finding);
      expect(prompt).toContain(`- ${p.path}: `);
    }
    expect(prompt).toContain("can also contain changes made outside this conversation");
    expect(prompt).toContain("do not undo work someone else made on purpose");
  });

  it("offers fix rounds until the cap, then only a summary", () => {
    expect(offer({ fixRound: 0 }).prompt).toContain("Fix round 1 of 2");
    expect(offer({ fixRound: 1 }).prompt).toContain("Fix round 2 of 2");
    // Issue #620 — the AI stages its own fixes; a "ask me to Stage" here
    // taught it the operator stages, and it stopped staging later work
    // (PR #624 real-AI homepage run).
    expect(offer().prompt).toContain("Stage again yourself (stage_changes)");
    expect(offer().prompt).not.toContain("ask me to Stage");
    const capped = offer({ fixRound: MAX_AUTO_FIX_ROUNDS });
    expect(capped.actionLabel).toBe("Summarise with AI");
    expect(capped.text).toContain("Let the AI summarise what is left?");
    expect(capped.prompt).toContain("Do not change the site further");
    expect(capped.prompt).toContain("accept_quality_findings");
  });

  it("never asks the AI to push for acceptances; platform findings become bug reports (#667)", () => {
    for (const fixRound of [0, 1, MAX_AUTO_FIX_ROUNDS]) {
      const { prompt } = offer({ fixRound });
      expect(prompt).not.toMatch(/ask me (to accept|whether to accept)/);
      expect(prompt).toContain("only when I explicitly ask");
      expect(prompt).toContain("bug_report");
    }
    const capped = offer({ fixRound: MAX_AUTO_FIX_ROUNDS }).prompt;
    expect(capped).toContain("without recommending to accept anything");
    expect(capped).toContain(
      "Publish live stays blocked until they are fixed or I decide to accept them",
    );
  });
});

describe("problemLabel", () => {
  it("names a failing audit by its title (and value), a score drop by its numbers", () => {
    expect(
      problemLabel({
        kind: "failing_audit",
        auditId: "color-contrast",
        title: "Low contrast",
        score: 0,
        categories: ["accessibility"],
      }),
    ).toBe("Low contrast");
    expect(
      problemLabel({
        kind: "failing_audit",
        auditId: "lcp",
        title: "Largest Contentful Paint",
        score: 0.3,
        categories: ["performance"],
        displayValue: "4.1 s",
      }),
    ).toBe("Largest Contentful Paint (4.1 s)");
    expect(
      problemLabel({ kind: "score_below_baseline", category: "seo", score: 88, baseline: 100 }),
    ).toBe("seo score 88 (was 100)");
  });
});
