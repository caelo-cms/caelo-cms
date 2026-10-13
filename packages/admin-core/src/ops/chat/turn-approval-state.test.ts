// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { chatApprovalStateOf, isOpenCard, type TurnApprovalStatus } from "./turn-approval-state.js";

const card = (status: TurnApprovalStatus, createdAt = "2026-10-13T10:00:00.000Z") => ({
  status,
  createdAt,
});

describe("isOpenCard (issue #658)", () => {
  it("keeps a decided-but-unresumed card open: the turn still has to apply it", () => {
    // codex review — a decision landing between the pause and the reply must
    // not read as "nothing to wait for", or the approved change never runs.
    expect(isOpenCard("pending")).toBe(true);
    expect(isOpenCard("approved")).toBe(true);
    expect(isOpenCard("rejected")).toBe(true);
    expect(isOpenCard("resumed")).toBe(false);
    expect(isOpenCard("superseded")).toBe(false);
  });
});

describe("chatApprovalStateOf", () => {
  it("is pending while any card of the turn is undecided", () => {
    expect(chatApprovalStateOf([card("approved"), card("pending")]).state).toBe("pending");
  });

  it("is decided once every open card has a decision", () => {
    const r = chatApprovalStateOf([card("rejected"), card("approved"), card("resumed")]);
    expect(r.state).toBe("decided");
    expect(r.approvals).toHaveLength(2);
  });

  it("reports the newest turn's dropped cards as superseded, older history as none", () => {
    const newest = "2026-10-13T11:00:00.000Z";
    const r = chatApprovalStateOf([card("superseded", newest), card("superseded")]);
    expect(r.state).toBe("superseded");
    expect(r.approvals).toHaveLength(1);
    expect(chatApprovalStateOf([card("resumed"), card("superseded")]).state).toBe("none");
    expect(chatApprovalStateOf([]).state).toBe("none");
  });
});
