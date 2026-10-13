// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  decisionStillCurrent,
  EXTERNAL_AGENT_LABEL,
  externalDecisionNote,
  followUpAfterDecision,
  handoffStatusText,
  isExternalRequest,
  isImportKind,
  ownDecisionMessage,
  sdkApprovalRoute,
} from "./approval-origin.js";

describe("followUpAfterDecision (issue #658)", () => {
  it("an external agent's request never continues this chat's AI — Power-MCP or caelo_chat", () => {
    for (const via of ["power_mcp", "mcp_chat"] as const) {
      expect(followUpAfterDecision(via, "approve").continueChatAi).toBe(false);
      expect(followUpAfterDecision(via, "reject").continueChatAi).toBe(false);
    }
  });

  it("this chat's own request continues its AI on Approve AND on Reject", () => {
    expect(followUpAfterDecision(null, "approve").continueChatAi).toBe(true);
    expect(followUpAfterDecision(null, "reject").continueChatAi).toBe(true);
    expect(followUpAfterDecision(undefined, "reject").continueChatAi).toBe(true);
  });
});

describe("decisionStillCurrent (issue #658)", () => {
  it("a Stop pressed after the click wins; a click after the Stop continues", () => {
    expect(decisionStillCurrent(0, 0)).toBe(true);
    expect(decisionStillCurrent(0, 1)).toBe(false);
    expect(decisionStillCurrent(1, 1)).toBe(true);
  });
});

describe("sdkApprovalRoute (issue #658)", () => {
  it("resumes this chat's own paused turn from the chat", () => {
    expect(sdkApprovalRoute(null)).toBe("resume-turn");
    expect(sdkApprovalRoute(undefined)).toBe("resume-turn");
  });

  it("only records the decision on an external agent's card — its own call resumes it", () => {
    expect(sdkApprovalRoute("mcp_chat")).toBe("record");
    expect(isExternalRequest("mcp_chat")).toBe(true);
    expect(isExternalRequest(null)).toBe(false);
  });
});

describe("ownDecisionMessage", () => {
  const proposalId = "1234abcd-0000-0000-0000-000000000000";

  it("tells the AI to continue after Approve, and to react after Reject", () => {
    expect(ownDecisionMessage({ kind: "layouts", proposalId, action: "approve" })).toBe(
      "Approved: layouts proposal 1234abcd applied to the chat branch. Please continue with what you were doing.",
    );
    expect(ownDecisionMessage({ kind: "layouts", proposalId, action: "reject" })).toBe(
      "Rejected: layouts proposal 1234abcd was not applied. Adjust your plan, or ask me how to proceed.",
    );
  });

  it("says an approved import runs in the background (raw and qualified kinds)", () => {
    for (const kind of ["site_import", "import.site_import"]) {
      expect(isImportKind(kind)).toBe(true);
      expect(ownDecisionMessage({ kind, proposalId, action: "approve" })).toContain(
        "runs in the background",
      );
    }
    expect(isImportKind("layouts")).toBe(false);
  });
});

describe("external-agent copy", () => {
  const base = { proposalId: "p", summary: "s", decidedAt: "2026-10-12T00:00:00Z" };

  it("the transcript note names the request, says the result goes back, and that this AI does not act", () => {
    const note = externalDecisionNote("approve", "Create an MCP token\n  displayName: x");
    expect(note).toBe(
      "Approved the external agent's (MCP) request: Create an MCP token — the result goes back to that agent, which continues from there. The AI in this chat does not act on it.",
    );
    expect(externalDecisionNote("reject", "")).toContain(
      "Rejected the external agent's (MCP) request: its request",
    );
  });

  it("says the result went back to the external agent, and when it picked it up", () => {
    expect(handoffStatusText({ ...base, outcome: "applied", deliveredAt: null })).toBe(
      "Approved and applied — the result is handed back to the external agent (MCP), waiting for it to pick it up.",
    );
    expect(
      handoffStatusText({ ...base, outcome: "rejected", deliveredAt: "2026-10-12T00:00:01Z" }),
    ).toBe("Rejected — the external agent (MCP) received the result and continues from there.");
    expect(handoffStatusText({ ...base, outcome: "approved", deliveredAt: null })).toMatch(
      /^Approved — /,
    );
  });

  it("a card dropped by a newer message before anyone decided says so", () => {
    expect(
      handoffStatusText({ ...base, decidedAt: null, outcome: "superseded", deliveredAt: null }),
    ).toBe("Dropped — a newer message in this chat moved on before it was decided.");
  });

  it("never names an AI vendor in the editor UI (CLAUDE.md §2)", () => {
    const copy = [
      EXTERNAL_AGENT_LABEL,
      externalDecisionNote("approve", "x"),
      externalDecisionNote("reject", "x"),
      handoffStatusText({ ...base, outcome: "failed", deliveredAt: null }),
    ].join(" ");
    expect(copy).not.toMatch(/claude|anthropic|openai|gpt|gemini/i);
  });
});
