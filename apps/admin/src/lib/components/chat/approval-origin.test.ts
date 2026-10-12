// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  EXTERNAL_AGENT_LABEL,
  followUpAfterDecision,
  handoffStatusText,
} from "./approval-origin.js";

describe("followUpAfterDecision (issue #658)", () => {
  it("an external agent's proposal never continues this chat's AI", () => {
    expect(followUpAfterDecision("power_mcp", "approve").continueChatAi).toBe(false);
    expect(followUpAfterDecision("power_mcp", "reject").continueChatAi).toBe(false);
  });

  it("this chat's own proposal still auto-continues on Approve, not on Reject", () => {
    expect(followUpAfterDecision(null, "approve").continueChatAi).toBe(true);
    expect(followUpAfterDecision(null, "reject").continueChatAi).toBe(false);
  });
});

describe("hand-back copy", () => {
  const base = { proposalId: "p", summary: "s", decidedAt: "2026-10-12T00:00:00Z" };

  it("says the result went back to the external agent, and when it picked it up", () => {
    expect(handoffStatusText({ ...base, outcome: "applied", deliveredAt: null })).toBe(
      "Approved and applied — the result is handed back to the external agent (MCP), waiting for it to pick it up.",
    );
    expect(
      handoffStatusText({ ...base, outcome: "rejected", deliveredAt: "2026-10-12T00:00:01Z" }),
    ).toBe("Rejected — the external agent (MCP) received the result and continues from there.");
  });

  it("never names an AI vendor in the editor UI (CLAUDE.md §2)", () => {
    const copy = [
      EXTERNAL_AGENT_LABEL,
      handoffStatusText({ ...base, outcome: "failed", deliveredAt: null }),
    ].join(" ");
    expect(copy).not.toMatch(/claude|anthropic|openai|gpt|gemini/i);
  });
});
