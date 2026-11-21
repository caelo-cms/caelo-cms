// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describeAiCapRefusal } from "./ai-ledger.js";

describe("refusal messages", () => {
  it("names the budget, the figures, what the call could cost and where to raise it", () => {
    const m = describeAiCapRefusal(
      {
        kind: "budget",
        scope: "day-global",
        operationType: "text",
        capMicrocents: 1_000_000_000,
        spentMicrocents: 990_000_000,
        requestedMicrocents: 45_000_000,
      },
      "this chat step",
    );
    expect(m).toContain("AiBudgetReached (day-global)");
    expect(m).toContain("$9.90 of $10.00 spent");
    expect(m).toContain("this chat step could cost up to $0.45");
    expect(m).toContain("propose_set_ai_budget");
  });

  it("keeps small amounts readable", () => {
    const m = describeAiCapRefusal(
      {
        kind: "plugin-budget",
        capMicrocents: 50_000,
        spentMicrocents: 40_000,
        requestedMicrocents: 15_000,
      },
      "the call",
    );
    expect(m).toContain("$0.0004 of $0.0005");
    expect(m).toContain("propose_set_plugin_ai_cost_cap");
  });

  it("says a session cap needs a chat", () => {
    expect(
      describeAiCapRefusal({ kind: "session-required", operationType: "image" }, "this image"),
    ).toContain("runs only inside a chat");
  });
});
