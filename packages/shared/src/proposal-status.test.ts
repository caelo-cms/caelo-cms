// SPDX-License-Identifier: MPL-2.0

/**
 * Unit guards for the canonical propose/execute status enum. The
 * load-bearing invariants: the four states never silently change order or
 * membership when ~14 pending-op schemas migrate to this shared source, and
 * the *proposal* enum never absorbs the semantically-different `"accepted"`
 * review-status family (CLAUDE.md §11.A, plan Out-of-scope §3).
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { PROPOSAL_STATUSES, type ProposalStatus, proposalStatus } from "./proposal-status.js";

describe("proposalStatus", () => {
  it("has exactly the four states, in canonical order", () => {
    expect(PROPOSAL_STATUSES).toEqual(["pending", "applied", "rejected", "superseded"]);
    expect(proposalStatus.options).toEqual(["pending", "applied", "rejected", "superseded"]);
  });

  it("parses every member back to itself", () => {
    for (const s of PROPOSAL_STATUSES) {
      expect(proposalStatus.parse(s)).toBe(s);
    }
  });

  it("rejects values outside the vocabulary (incl. the review-status family)", () => {
    // "accepted" is the skill/ai-memory review vocabulary, NOT a proposal
    // state — this guard is why the two enums must stay separate.
    expect(proposalStatus.safeParse("accepted").success).toBe(false);
    expect(proposalStatus.safeParse("draft").success).toBe(false);
    expect(proposalStatus.safeParse("all").success).toBe(false);
    expect(proposalStatus.safeParse("").success).toBe(false);
  });

  it("derives the documented domain variants without re-typing the 4-tuple", () => {
    // locales list-filter: + "all"
    expect(z.enum([...PROPOSAL_STATUSES, "all"] as const).options).toEqual([
      "pending",
      "applied",
      "rejected",
      "superseded",
      "all",
    ]);
    // themes: + "cancelled"
    expect(z.enum([...PROPOSAL_STATUSES, "cancelled"] as const).options).toEqual([
      "pending",
      "applied",
      "rejected",
      "superseded",
      "cancelled",
    ]);
    // deploy proposals: no "superseded"
    expect(proposalStatus.exclude(["superseded"]).options).toEqual([
      "pending",
      "applied",
      "rejected",
    ]);
  });

  it("exports a ProposalStatus type that is the union and nothing wider", () => {
    const ok: ProposalStatus = "pending";
    expect(ok).toBe("pending");
    // @ts-expect-error "accepted" is not a ProposalStatus
    const bad: ProposalStatus = "accepted";
    // reference `bad` so the binding isn't elided before the ts-expect-error applies
    expect(typeof bad).toBe("string");
  });
});
