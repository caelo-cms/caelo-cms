// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { approvedCallRunsLive } from "../plugin-invocation.js";

describe("approvedCallRunsLive", () => {
  it("applies live only for an approver who may publish", () => {
    expect(approvedCallRunsLive(true, {})).toBe(true);
    expect(approvedCallRunsLive(false, {})).toBe(false);
  });

  // An Owner approving an embed the chat just added: main does not have
  // the module (or has it with other hosts), so a live run judged
  // something other than what the card showed (PR #1206 review).
  it("keeps a draft-bound tool on the chat's branch even for a publisher", () => {
    expect(approvedCallRunsLive(true, { approvedOnChatBranch: true })).toBe(false);
    expect(approvedCallRunsLive(false, { approvedOnChatBranch: true })).toBe(false);
  });
});
