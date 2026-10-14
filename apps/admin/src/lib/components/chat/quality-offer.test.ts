// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { AgentRunView } from "#lib/components/agents/agent-runs-client.js";
import type {
  QualityProblemGroup,
  QualityStatus,
} from "#lib/components/edit/quality-status.svelte.js";
import {
  autoDeliverableNote,
  externalAgentRefusal,
  groupSelection,
  openQualityOffer,
  selectionPageCount,
  workingExternalAgent,
} from "./quality-offer.js";

const GROUP: QualityProblemGroup = {
  key: "seo-check/description-missing",
  ref: { ruleId: "seo-check/description-missing" },
  title: "Missing meta description",
  pages: [
    { pageId: "p1", pagePath: "/", detail: "1×" },
    { pageId: "p2", pagePath: "/about", detail: "1×" },
    { pageId: "p3", pagePath: "/team", detail: "1×" },
  ],
};

function status(over: Partial<QualityStatus> = {}): QualityStatus {
  return {
    audit: { id: "a1", status: "problems" },
    notified: false,
    feedback: {
      kind: "offer",
      text: "Quality check found 2 issue(s) on 1 page(s): / (contrast). Let the AI fix them?",
      actionLabel: "Fix all with AI",
      prompt: "Please fix the quality findings. …",
      groups: [GROUP],
    },
    deployRunId: "d1",
    gate: null,
    ...over,
  };
}

function run(over: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id: "r1",
    chatSessionId: "c1",
    chatTitle: "Homepage",
    kind: "mcp",
    source: "power_mcp",
    label: "Claude Code",
    state: "running",
    parentRunId: null,
    createdAt: "2026-10-13T10:00:00Z",
    heartbeatAt: "2026-10-13T10:00:00Z",
    cancelRequested: false,
    ...over,
  };
}

describe("openQualityOffer (issue #685)", () => {
  it("problems become a card, never an automatic delivery", () => {
    const s = status();
    expect(openQualityOffer(s)).toEqual({
      auditRunId: "a1",
      text: expect.stringContaining("Let the AI fix them?"),
      actionLabel: "Fix all with AI",
      groups: [GROUP],
    });
    expect(autoDeliverableNote(s)).toBeNull();
  });

  it("no card once the operator decided, while running, or for a status note", () => {
    expect(openQualityOffer(status({ notified: true }))).toBeNull();
    expect(openQualityOffer(status({ feedback: null }))).toBeNull();
    expect(openQualityOffer(status({ audit: null }))).toBeNull();
    expect(
      openQualityOffer(status({ feedback: { kind: "note", text: "Quality check passed" } })),
    ).toBeNull();
    expect(openQualityOffer(null)).toBeNull();
  });

  it("status notes are still delivered on their own (they start no turn)", () => {
    const note = status({ feedback: { kind: "note", text: "Quality check passed" } });
    expect(autoDeliverableNote(note)).toBe("a1");
    expect(autoDeliverableNote({ ...note, notified: true })).toBeNull();
  });
});

describe("workingExternalAgent (issues #682 / #685)", () => {
  it("a running external agent blocks the click", () => {
    const agent = workingExternalAgent([run({ kind: "turn", source: "live_edit" }), run()]);
    expect(agent?.label).toBe("Claude Code");
    expect(externalAgentRefusal(run())).toContain("The AI was not started");
  });

  it("stopped, stopping, or no external agents do not", () => {
    expect(workingExternalAgent([run({ state: "stopped" })])).toBeNull();
    expect(workingExternalAgent([run({ cancelRequested: true })])).toBeNull();
    expect(workingExternalAgent([run({ kind: "turn", source: "live_edit" })])).toBeNull();
    expect(workingExternalAgent(null)).toBeNull();
  });
});

describe("groupSelection (#727 bulk decisions on the card)", () => {
  it("the whole group when not picking", () => {
    expect(groupSelection(GROUP, null)).toEqual({ key: GROUP.key });
  });

  it("only the ticked pages when picking; all ticked is the whole group", () => {
    const some = groupSelection(GROUP, new Set(["/about", "/elsewhere"]));
    expect(some).toEqual({ key: GROUP.key, pagePaths: ["/about"] });
    expect(selectionPageCount(GROUP, some as NonNullable<typeof some>)).toBe(1);
    expect(groupSelection(GROUP, new Set(["/", "/about", "/team"]))).toEqual({ key: GROUP.key });
    expect(selectionPageCount(GROUP, { key: GROUP.key })).toBe(3);
  });

  it("nothing ticked selects nothing", () => {
    expect(groupSelection(GROUP, new Set())).toBeNull();
  });
});
