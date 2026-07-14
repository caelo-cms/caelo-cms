// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the `subagent_runs.finish` ownership gate (PR #295
 * review). Regression: pre-fix, ANY AI actor could finish ANY run by id
 * and force-release the run's entity leases via releaseLeasesByHolder —
 * a lease-steal primitive between rival orchestrators. The predicate is
 * pure, so every allow/deny branch is covered here without a Postgres;
 * the DB wiring is exercised by subagents.integration.test.ts in CI.
 */

import { describe, expect, it } from "bun:test";
import { evaluateFinishRunAuthorization } from "./finish-authorization.js";

const RUN = {
  id: "11111111-1111-4111-8111-111111111111",
  subagentChatSessionId: "22222222-2222-4222-8222-222222222222",
  parentChatSessionId: "33333333-3333-4333-8333-333333333333",
};

describe("evaluateFinishRunAuthorization", () => {
  it("allows human actors regardless of session", () => {
    expect(evaluateFinishRunAuthorization("human", null, RUN)).toEqual({ allowed: true });
  });

  it("allows system actors regardless of session", () => {
    expect(evaluateFinishRunAuthorization("system", "unrelated-session", RUN)).toEqual({
      allowed: true,
    });
  });

  it("allows the AI orchestrator that spawned the run (parent session)", () => {
    expect(evaluateFinishRunAuthorization("ai", RUN.parentChatSessionId, RUN)).toEqual({
      allowed: true,
    });
  });

  it("allows the run's own subagent session", () => {
    expect(evaluateFinishRunAuthorization("ai", RUN.subagentChatSessionId, RUN)).toEqual({
      allowed: true,
    });
  });

  it("denies an AI actor from an unrelated session, naming the mismatch", () => {
    const rival = "44444444-4444-4444-8444-444444444444";
    const d = evaluateFinishRunAuthorization("ai", rival, RUN);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      // AI-actionable per CLAUDE.md §11: names both sides of the
      // mismatch and points at the next step.
      expect(d.message).toContain(RUN.id);
      expect(d.message).toContain(RUN.subagentChatSessionId);
      expect(d.message).toContain(RUN.parentChatSessionId);
      expect(d.message).toContain(rival);
      expect(d.message).toContain("subagent_runs.list");
    }
  });

  it("denies an AI actor with no chat session identity (fail closed)", () => {
    const d = evaluateFinishRunAuthorization("ai", null, RUN);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.message).toContain("<none>");
    }
  });

  it("never treats a null parent as a wildcard match", () => {
    // A run spawned with no parent session must not become finishable by
    // arbitrary AI sessions just because parentChatSessionId is null.
    const orphan = { ...RUN, parentChatSessionId: null };
    const d = evaluateFinishRunAuthorization("ai", "55555555-5555-4555-8555-555555555555", orphan);
    expect(d.allowed).toBe(false);
    const own = evaluateFinishRunAuthorization("ai", orphan.subagentChatSessionId, orphan);
    expect(own).toEqual({ allowed: true });
  });
});
