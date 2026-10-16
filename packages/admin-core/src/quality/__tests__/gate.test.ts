// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type ChatAuditSummary,
  type ChatFeedback,
  chatFeedbackFor,
  fixDistance,
  fixPromptFor,
  madeProgress,
} from "../chat-feedback.js";
import {
  CURRENT_GATE_RULES,
  checkKey,
  decideGate,
  findingKey,
  type GateAcceptances,
  type GateAudit,
  scoreKey,
} from "../gate.js";
import { groupOpenProblems, type ProblemGroup } from "../problem-groups.js";
import { ACCEPTED_PERFORMANCE_TOLERANCE } from "../ratchet.js";

const NONE: GateAcceptances = {
  findings: new Map(),
  scores: new Map(),
  checks: new Map(),
};

function accepting(over: Partial<GateAcceptances>): GateAcceptances {
  return { ...NONE, ...over };
}

function audit(over: Partial<GateAudit> = {}): GateAudit {
  return {
    id: "a1",
    gateRules: CURRENT_GATE_RULES,
    status: "passed",
    errorCode: null,
    errorMessage: null,
    publishOverride: null,
    pages: [],
    siteProblems: [],
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
    expect(d.message).toContain("/about: accessibility 92 < 100");
    // #727 — the target is the optimum; only the unfixable goes to the
    // operator, as a bulk decision, never as the AI's recommendation (#667).
    expect(d.message).toContain("The target is 100 in every category and zero findings");
    expect(d.message).toContain("never call a score below 100 good enough");
    expect(d.message).toContain("accept_quality_findings with groups");
    expect(d.message).toContain("bug_report");
  });

  it("acceptances on the page clear their problems; partially accepted still blocks", () => {
    const findings = new Map([[findingKey("p-about", "color-contrast"), 0]]);
    const partial = decideGate(
      audit({ status: "problems", pages: problems }),
      accepting({ findings }),
    );
    expect(partial).toMatchObject({ open: false, state: "problems" });
    expect(partial.openProblems).toHaveLength(1);
    const all = decideGate(
      audit({ status: "problems", pages: problems }),
      accepting({ findings, scores: new Map([[scoreKey("p-about", "accessibility"), 92]]) }),
    );
    expect(all).toMatchObject({ open: true, state: "accepted" });
  });

  it("an accepted deterministic value covers that value or better — one point worse blocks", () => {
    const d = decideGate(
      audit({ status: "problems", pages: problems }),
      accepting({
        findings: new Map([[findingKey("p-about", "color-contrast"), 0]]),
        scores: new Map([[scoreKey("p-about", "accessibility"), 93]]),
      }),
    );
    expect(d.open).toBe(false);
    expect(d.openProblems.map((o) => o.problem.kind)).toEqual(["score_below_baseline"]);
  });

  it("an accepted audit score blocks again when the audit scores worse", () => {
    const halfway: GateAudit["pages"] = [
      {
        pageId: "p-about",
        pagePath: "/about",
        problems: [
          {
            kind: "failing_audit",
            auditId: "uses-responsive-images",
            title: "Properly size images",
            score: 0.5,
            categories: ["performance", "best-practices"],
          },
        ],
      },
    ];
    const key = findingKey("p-about", "uses-responsive-images");
    expect(
      decideGate(
        audit({ status: "problems", pages: halfway }),
        accepting({ findings: new Map([[key, 50]]) }),
      ).open,
    ).toBe(true);
    expect(
      decideGate(
        audit({ status: "problems", pages: halfway }),
        accepting({ findings: new Map([[key, 60]]) }),
      ).open,
    ).toBe(false);
    // A finding accepted before 0276 recorded values covers it as recorded.
    expect(
      decideGate(
        audit({ status: "problems", pages: halfway }),
        accepting({ findings: new Map([[key, null]]) }),
      ).open,
    ).toBe(true);
  });

  it("Performance is compared with an accepted value within the noise tolerance, never with the target", () => {
    const perf = (score: number): GateAudit["pages"] => [
      {
        pageId: "p",
        pagePath: "/",
        problems: [{ kind: "score_below_baseline", category: "performance", score, baseline: 100 }],
      },
    ];
    // Without an acceptance 99 blocks: no "good enough" bar.
    expect(decideGate(audit({ status: "problems", pages: perf(99) }), NONE).open).toBe(false);
    const accepted = accepting({ scores: new Map([[scoreKey("p", "performance"), 90]]) });
    const within = 90 - ACCEPTED_PERFORMANCE_TOLERANCE;
    expect(decideGate(audit({ status: "problems", pages: perf(within) }), accepted).open).toBe(
      true,
    );
    expect(decideGate(audit({ status: "problems", pages: perf(within - 1) }), accepted).open).toBe(
      false,
    );
    // Deterministic categories get no tolerance at all.
    const a11y: GateAudit["pages"] = [
      {
        pageId: "p",
        pagePath: "/",
        problems: [
          { kind: "score_below_baseline", category: "accessibility", score: 89, baseline: 100 },
        ],
      },
    ];
    expect(
      decideGate(
        audit({ status: "problems", pages: a11y }),
        accepting({ scores: new Map([[scoreKey("p", "accessibility"), 90]]) }),
      ).open,
    ).toBe(false);
  });

  it("a check acceptance covers up to its count; one more error blocks", () => {
    const rule = (count: number): GateAudit["pages"] => [
      {
        pageId: "p",
        pagePath: "/",
        problems: [
          {
            kind: "check_rule",
            checkId: "seo-check",
            ruleId: "seo-check/description-missing",
            count,
            allowed: 0,
            findings: [{ message: "Missing meta description" }],
          },
        ],
      },
    ];
    const accepted = accepting({
      checks: new Map([[checkKey("p", "seo-check/description-missing"), 2]]),
    });
    expect(decideGate(audit({ status: "problems", pages: rule(2) }), accepted).open).toBe(true);
    expect(decideGate(audit({ status: "problems", pages: rule(3) }), accepted).open).toBe(false);
  });

  it("an acceptance never covers another page", () => {
    const d = decideGate(
      audit({ status: "problems", pages: problems }),
      accepting({
        findings: new Map([[findingKey("p-home", "color-contrast"), 0]]),
        scores: new Map([[scoreKey("p-home", "accessibility"), 50]]),
      }),
    );
    expect(d.openProblems).toHaveLength(2);
  });

  it("an audit recorded under the earlier rules (baselines, 0.9 pass) is not trusted", () => {
    for (const status of ["passed", "problems", "skipped"] as const) {
      const d = decideGate(audit({ status, gateRules: 1, pages: [] }), NONE);
      expect(d).toMatchObject({ open: false, state: "missing" });
      expect(d.message).toContain("earlier quality rules");
      expect(d.message).toContain("retry_quality_audit");
    }
    // A failed old audit stays a failed audit (retry it either way).
    expect(
      decideGate(audit({ status: "errored", gateRules: 1, errorMessage: "x" }), NONE).state,
    ).toBe("errored");
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
    stagedBy: null,
    errorCode: null,
    errorMessage: null,
    skippedBecause: [] as string[],
    lighthouse: true,
    groups: [] as ProblemGroup[],
    fixChain: null as ChatAuditSummary["fixChain"],
  };
  const descriptionMissing = (path: string) => ({
    pageId: `id-${path}`,
    pagePath: path,
    problem: {
      kind: "check_rule" as const,
      checkId: "seo-check",
      ruleId: "seo-check/description-missing",
      count: 1,
      allowed: 0,
      findings: [{ message: "Missing meta description" }],
    },
  });
  const groups = groupOpenProblems([
    ...["/", "/a", "/b", "/c"].map(descriptionMissing),
    {
      pageId: "id-/",
      pagePath: "/",
      problem: {
        kind: "score_below_baseline",
        category: "performance",
        score: 90,
        baseline: 100,
      },
    },
    {
      pageId: "id-/a",
      pagePath: "/a",
      problem: {
        kind: "failing_audit",
        auditId: "unused-javascript",
        title: "Reduce unused JavaScript",
        score: 0.5,
        categories: ["performance"],
      },
    },
  ]);
  type Offer = Extract<ChatFeedback, { kind: "offer" }>;
  const offer = (over: Partial<ChatAuditSummary> = {}): Offer => {
    const f = chatFeedbackFor({ ...base, status: "problems", groups, ...over });
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

  it("problems an editor accepted entirely are a note, not an offer", () => {
    const f = chatFeedbackFor({ ...base, status: "problems", groups: [] });
    expect(f?.kind).toBe("note");
    expect(f?.text).toContain("every remaining finding is accepted");
  });

  it("problems are an offer with the open groups — for every origin of the Stage (#685)", () => {
    for (const stagedBy of ["operator", "live_edit_ai", "other_agent", null] as const) {
      const f = offer({ stagedBy });
      expect(f.actionLabel).toBe("Fix all with AI");
      expect(f.text).toContain("Quality check found 3 kind(s) of issue on 4 page(s)");
      expect(f.text).toContain("Missing meta description (4 page(s))");
      expect(f.text).toContain("The target is 100 and zero findings");
      expect(f.groups.map((g) => [g.key, g.pages.length])).toEqual([
        ["seo-check/description-missing", 4],
        ["lighthouse/performance/score", 1],
        ["lighthouse/performance/unused-javascript", 1],
      ]);
    }
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

  it("the prompt lists every group with its pages and the 'not only your changes' note", () => {
    const { prompt } = offer({ stagedBy: "operator" });
    expect(prompt).toContain(
      "- seo-check/description-missing — Missing meta description: 4 page(s) (/, /a, /b, /c)",
    );
    expect(prompt).toContain("- lighthouse/performance/score — Performance score below 100");
    expect(prompt).toContain("can also contain changes made outside this conversation");
    expect(prompt).toContain("do not undo work someone else made on purpose");
  });

  it("every fix request holds the AI to the optimum and keeps acceptances the operator's (#727, #667)", () => {
    for (const fixRound of [0, 1, 5]) {
      const { prompt } = offer({ fixRound });
      expect(prompt).toContain("a score like 90 is NOT good enough on its own");
      expect(prompt).toContain("Keep fixing until the target is reached");
      expect(prompt).toContain("never run Lighthouse yourself");
      expect(prompt).toContain("ONE decision per group with accept_quality_findings");
      expect(prompt).toContain("never as your recommendation");
      expect(prompt).toContain("bug_report");
      // Issue #620 — the AI stages its own fixes.
      expect(prompt).toContain("Stage again yourself (stage_changes)");
    }
  });

  it("an offer nobody asked to fix waits for the operator's click (#685)", () => {
    const f = offer({ stagedBy: "live_edit_ai" });
    expect(f.autoContinue).toBe(false);
    expect(f.actionLabel).toBe("Fix all with AI");
    expect(f.prompt).toContain("Fix round 1:");
  });

  // #771 — one "Fix all with AI" fixes until the target, not one click per round.
  it("a fix round that got closer to the target continues without a click", () => {
    const fewer = offer({
      fixRound: 1,
      fixChain: {
        before: { openCount: 9, scoreShortfall: 20 },
        now: { openCount: 6, scoreShortfall: 30 },
      },
    });
    expect(fewer.autoContinue).toBe(true);
    expect(fewer.text).toContain("from 9 open problem(s), 20 score point(s) below 100 to 6");
    expect(fewer.text).toContain("keeps fixing on its own");
    expect(fewer.prompt).toContain("Fix round 2:");
    expect(fewer.prompt).toContain("The chat sends you the next round on its own");
    // Same number of problems, but higher scores: still closer.
    const higher = offer({
      fixChain: {
        before: { openCount: 3, scoreShortfall: 12 },
        now: { openCount: 3, scoreShortfall: 4 },
      },
    });
    expect(higher.autoContinue).toBe(true);
  });

  it("a fix round that got no closer stops the loop and asks the operator", () => {
    for (const now of [
      { openCount: 3, scoreShortfall: 12 },
      { openCount: 4, scoreShortfall: 0 },
    ]) {
      const stalled = offer({ fixChain: { before: { openCount: 3, scoreShortfall: 12 }, now } });
      expect(stalled.autoContinue).toBe(false);
      expect(stalled.actionLabel).toBe("Keep fixing with AI");
      expect(stalled.text).toContain("got no closer to the target");
      expect(stalled.text).toContain("decide per group below");
      expect(stalled.groups).toHaveLength(3);
    }
  });

  it("measures the distance as open problems plus missing score points", () => {
    const open = [
      {
        pageId: "p",
        pagePath: "/",
        problem: {
          kind: "score_below_baseline" as const,
          category: "seo" as const,
          score: 92,
          baseline: 100,
        },
      },
      descriptionMissing("/"),
    ];
    expect(fixDistance(open)).toEqual({ openCount: 2, scoreShortfall: 8 });
    expect(
      madeProgress({ openCount: 2, scoreShortfall: 8 }, { openCount: 1, scoreShortfall: 50 }),
    ).toBe(true);
    expect(
      madeProgress({ openCount: 2, scoreShortfall: 8 }, { openCount: 2, scoreShortfall: 8 }),
    ).toBe(false);
  });

  it("a picked fix does not promise the next round", () => {
    const summary = { ...base, status: "problems" as const, groups };
    expect(fixPromptFor(summary, [{ key: "seo-check/description-missing" }])).not.toContain(
      "next round on its own",
    );
  });

  it("a picked fix covers only the chosen groups and pages", () => {
    const summary = { ...base, status: "problems" as const, groups };
    const prompt = fixPromptFor(summary, [
      { key: "seo-check/description-missing", pagePaths: ["/b"] },
    ]);
    expect(prompt).toContain("these quality findings I picked: 1 group(s) on 1 page(s)");
    expect(prompt).toContain(
      "seo-check/description-missing — Missing meta description: 1 page(s) (/b)",
    );
    expect(prompt).not.toContain("unused-javascript");
    expect(fixPromptFor(summary, [{ key: "nope" }])).toBeNull();
  });
});
