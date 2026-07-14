// SPDX-License-Identifier: MPL-2.0

/**
 * issue #306 — unit tests for needs_escalation routing in the wave
 * orchestrator (mock spawn fn, no DB/provider — same style as
 * subagent-waves.test.ts) plus the editor-facing brand rule on the
 * summarize path:
 *
 *   1. A small-tier child's needs_escalation pages re-dispatch at "mid"
 *      with the child's reason threaded into the escalated brief.
 *   2. Ladder: mid → inherit; small → inherit when "mid" is unmapped
 *      (routing UP past a missing rung, never silently down).
 *   3. Depth bound (1): an escalated child that escalates again stops
 *      loudly (`escalation-limit`), as does an inherit child (no rung
 *      above the parent).
 *   4. Composition with #304 partials: one child can be partial for cost
 *      AND escalate different pages — the remainder continues at its own
 *      tier while the escalated pages fork a higher-tier line, and both
 *      merge back into ONE final entry.
 *   5. Brand rule: summarize() output carries no tier labels and no
 *      model/provider names (editors see "AI", CLAUDE.md §2).
 */

import { describe, expect, it } from "bun:test";
import type { SpawnSubagentToolInput } from "@caelo-cms/shared";
import { summarize } from "../tools/spawn-subagent.js";
import { runSubagentWaves, type SubagentInvocationResult } from "../tools/subagent-batch.js";
import { escalateSpecTier, MAX_ESCALATION_DEPTH } from "../tools/subagent-budget.js";

function spec(role: string, extra: Partial<SpawnSubagentToolInput> = {}): SpawnSubagentToolInput {
  return {
    role,
    task: `rebuild pages for ${role}`,
    expectedReturnShape: "rebuild",
    timeoutMs: 60_000,
    ...extra,
  } as SpawnSubagentToolInput;
}

type Page = {
  slug: string;
  status: "rebuilt" | "skipped" | "failed" | "needs_escalation";
  notes?: string;
};

function completedWith(role: string, pages: Page[], cost = 10): SubagentInvocationResult {
  return {
    role,
    status: "completed",
    resultJson: { pages, summary: "done" },
    costMicrocents: cost,
    durationMs: 5,
    subagentChatSessionId: `sess-${role}`,
  };
}

const BOTH_TIERS = new Set(["mid", "small"]);

const OPTS = {
  maxParallel: 4,
  fallbackChildCapMicrocents: 250,
  fallbackBatchCapMicrocents: 1_000,
  maxWaves: 5,
  fetchRunBudget: null,
};

describe("runSubagentWaves — escalation re-dispatch (issue #306)", () => {
  it("re-dispatches a small child's needs_escalation pages at mid, threading the reason", async () => {
    const calls: { tier: string | undefined; task: string }[] = [];
    const outcome = await runSubagentWaves(
      [spec("bulk", { tier: "small" })],
      async (s) => {
        calls.push({ tier: s.tier, task: s.task });
        if (calls.length === 1) {
          return completedWith("bulk", [
            { slug: "p-1", status: "rebuilt" },
            { slug: "p-2", status: "needs_escalation", notes: "no matching pricing-table module" },
          ]);
        }
        return completedWith("bulk", [{ slug: "p-2", status: "rebuilt" }], 40);
      },
      { ...OPTS, availableTiers: BOTH_TIERS },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.tier).toBe("small");
    expect(calls[1]?.tier).toBe("mid");
    // The escalated brief carries the flagging child's reason verbatim +
    // the original task as ground truth.
    expect(calls[1]?.task).toContain("ESCALATED TASK");
    expect(calls[1]?.task).toContain("p-2: no matching pricing-table module");
    expect(calls[1]?.task).toContain("rebuild pages for bulk");
    expect(outcome.waves).toBe(2);

    // ONE final entry; both lines merged; the escalated attempt's page
    // status wins over the needs_escalation placeholder.
    expect(outcome.results).toHaveLength(1);
    const final = outcome.results[0] as SubagentInvocationResult;
    expect(final.status).toBe("completed");
    expect(final.costMicrocents).toBe(50);
    const pages = (final.resultJson as { pages: Page[] }).pages;
    expect(pages.find((p) => p.slug === "p-2")?.status).toBe("rebuilt");
    expect(pages.find((p) => p.slug === "p-1")?.status).toBe("rebuilt");
  });

  it("escalates a mid child to inherit, and a small child to inherit when mid is unmapped", async () => {
    for (const [childTier, available, expected] of [
      ["mid", BOTH_TIERS, "inherit"],
      ["small", new Set(["small"]), "inherit"],
    ] as const) {
      const tiers: (string | undefined)[] = [];
      await runSubagentWaves(
        [spec("t", { tier: childTier })],
        async (s) => {
          tiers.push(s.tier);
          if (tiers.length === 1) {
            return completedWith("t", [
              { slug: "x", status: "needs_escalation", notes: "layout decision needed" },
            ]);
          }
          return completedWith("t", [{ slug: "x", status: "rebuilt" }]);
        },
        { ...OPTS, availableTiers: available },
      );
      expect(tiers).toEqual([childTier, expected]);
    }
  });
});

describe("runSubagentWaves — escalation depth bound (issue #306)", () => {
  it("stops loudly when an escalated child escalates again (depth bound 1)", async () => {
    expect(MAX_ESCALATION_DEPTH).toBe(1);
    let attempts = 0;
    const outcome = await runSubagentWaves(
      [spec("stuck", { tier: "small" })],
      async () => {
        attempts += 1;
        return completedWith("stuck", [
          { slug: "hard", status: "needs_escalation", notes: "still cannot decide the layout" },
        ]);
      },
      { ...OPTS, availableTiers: BOTH_TIERS },
    );
    // small attempt + ONE escalated attempt — never a third.
    expect(attempts).toBe(2);
    const final = outcome.results[0] as SubagentInvocationResult;
    expect(final.status).toBe("partial");
    expect(final.errorKind).toBe("escalation-limit");
    expect(final.errorMessage).toContain("hard");
    expect(final.errorMessage).toContain("still cannot decide the layout");
    expect(final.errorMessage).toContain("NOT re-dispatched");
  });

  it("an inherit child's escalation has no rung above — loud stop, no re-dispatch", async () => {
    expect(escalateSpecTier("inherit", BOTH_TIERS)).toBeNull();
    let attempts = 0;
    const outcome = await runSubagentWaves(
      [spec("top")],
      async () => {
        attempts += 1;
        return completedWith("top", [
          { slug: "odd", status: "needs_escalation", notes: "unexpected source structure" },
        ]);
      },
      { ...OPTS, availableTiers: BOTH_TIERS },
    );
    expect(attempts).toBe(1);
    const final = outcome.results[0] as SubagentInvocationResult;
    expect(final.status).toBe("partial");
    expect(final.errorKind).toBe("escalation-limit");
    expect(final.errorMessage).toContain("unexpected source structure");
  });
});

describe("runSubagentWaves — escalation composes with #304 partials", () => {
  it("a child can be partial for cost AND escalate different pages; both lines merge into one final", async () => {
    const calls: { tier: string | undefined; task: string }[] = [];
    const outcome = await runSubagentWaves(
      [spec("mixed", { tier: "small" })],
      async (s) => {
        calls.push({ tier: s.tier, task: s.task });
        if (calls.length === 1) {
          // Wave 0: hit the cost cap after one page; one page escalated,
          // one page left as remainder for the same tier.
          return {
            role: "mixed",
            status: "partial",
            resultJson: {
              pages: [
                { slug: "m-1", status: "rebuilt" },
                {
                  slug: "m-2",
                  status: "needs_escalation",
                  notes: "needs a brand-new gallery module",
                },
                { slug: "m-3", status: "skipped", notes: "not reached: cost cap" },
              ],
              summary: "stopped at cost budget",
            },
            costMicrocents: 90,
            durationMs: 5,
            subagentChatSessionId: "sess-mixed",
            partial: {
              completedPages: [{ slug: "m-1" }],
              remainingPages: [{ slug: "m-3", notes: "not reached: cost cap" }],
            },
          } satisfies SubagentInvocationResult;
        }
        if (s.task.includes("ESCALATED TASK")) {
          return completedWith("mixed", [{ slug: "m-2", status: "rebuilt" }], 40);
        }
        return completedWith("mixed", [{ slug: "m-3", status: "rebuilt" }], 20);
      },
      { ...OPTS, availableTiers: BOTH_TIERS },
    );

    // Wave 1 dispatched BOTH lines: the same-tier remainder and the
    // escalated fork.
    expect(calls).toHaveLength(3);
    const wave1 = calls.slice(1);
    const remainder = wave1.find((c) => c.task.includes("CONTINUATION"));
    const escalated = wave1.find((c) => c.task.includes("ESCALATED TASK"));
    expect(remainder?.tier).toBe("small");
    expect(remainder?.task).toContain("m-3");
    expect(escalated?.tier).toBe("mid");
    expect(escalated?.task).toContain("m-2: needs a brand-new gallery module");
    // The remainder brief does NOT re-list the escalated page.
    expect(remainder?.task).not.toContain("m-2");

    // ONE merged final: every page landed, spend summed across all lines.
    expect(outcome.results).toHaveLength(1);
    const final = outcome.results[0] as SubagentInvocationResult;
    expect(final.status).toBe("completed");
    expect(final.costMicrocents).toBe(150);
    const bySlug = new Map(
      (final.resultJson as { pages: Page[] }).pages.map((p) => [p.slug, p.status]),
    );
    expect(bySlug.get("m-1")).toBe("rebuilt");
    expect(bySlug.get("m-2")).toBe("rebuilt");
    expect(bySlug.get("m-3")).toBe("rebuilt");
  });
});

describe("summarize — editor-facing brand rule (issue #306)", () => {
  it("never leaks tier labels or model/provider names into the tool result text", async () => {
    // Drive a realistic tiered flow (escalation + limit stop) and feed
    // the FINAL results through the same summarize() the tool handler
    // returns to the (editor-facing) parent chat.
    const outcome = await runSubagentWaves(
      [spec("bulk", { tier: "small" }), spec("stuck", { tier: "small" })],
      async (s) => {
        if (s.role === "bulk") {
          return completedWith("bulk", [{ slug: "b-1", status: "rebuilt" }]);
        }
        return completedWith("stuck", [
          { slug: "hard", status: "needs_escalation", notes: "no matching module pattern" },
        ]);
      },
      { ...OPTS, availableTiers: BOTH_TIERS },
    );
    const text = summarize(outcome.results);

    // The reason itself is relayed (the parent must act on it)…
    expect(text).toContain("no matching module pattern");
    // …but no provider/model branding and no tier vocabulary.
    expect(text).not.toMatch(/claude|sonnet|haiku|opus|anthropic|gpt|gemini/i);
    expect(text).not.toMatch(/model tier/i);
    expect(text).not.toMatch(/"(mid|small|inherit)"/);
    expect(text).not.toMatch(/\btier\b/i);
  });
});
