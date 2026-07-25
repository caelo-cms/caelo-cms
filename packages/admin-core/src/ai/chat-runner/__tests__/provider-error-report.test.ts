// SPDX-License-Identifier: MPL-2.0

/**
 * Theme A — the turn-fatal provider-error bug-report digest. The digest is
 * what makes an auto `ai_bug_reports` row actionable: it must point at the
 * exact dangling tool_use/tool_result pair the provider 400'd on.
 */

import { describe, expect, it } from "bun:test";

import type { ChatMessageInput } from "../../provider.js";
import { summarizeHistoryForBugReport } from "../provider-error-report.js";

describe("summarizeHistoryForBugReport", () => {
  it("flags an unanswered tool_use (the messages.N pairing 400)", () => {
    const messages: ChatMessageInput[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toolu_AwCV", name: "inspect_external_page", arguments: {} }],
      },
      { role: "user", content: "retry" },
    ];
    const digest = summarizeHistoryForBugReport(messages);
    expect(digest).toContain("toolu_AwCV!UNANSWERED");
    expect(digest).toContain("#1 assistant");
    expect(digest).toContain("(3 messages)");
  });

  it("does NOT flag an answered pair, and marks a passthrough row as sdk(N)", () => {
    const messages: ChatMessageInput[] = [
      { role: "user", content: "list" },
      {
        role: "assistant",
        content: "",
        sdkMessages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "x" }] }],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toolu_ok", name: "list_pages", arguments: {} }],
      },
      { role: "tool", content: "3", toolCallId: "toolu_ok" },
    ];
    const digest = summarizeHistoryForBugReport(messages);
    expect(digest).toContain("sdk(1)");
    expect(digest).toContain("toolu_ok");
    // The answered pair is NOT flagged (the bare "!UNANSWERED"/"!ORPHAN"
    // tokens appear in the header legend, so assert the id-specific form).
    expect(digest).not.toContain("toolu_ok!UNANSWERED");
    expect(digest).not.toContain(")!ORPHAN");
  });

  it("flags an orphan tool_result", () => {
    const messages: ChatMessageInput[] = [
      { role: "user", content: "x" },
      { role: "tool", content: "stray", toolCallId: "toolu_stray" },
    ];
    const digest = summarizeHistoryForBugReport(messages);
    expect(digest).toContain("toolu_stray)!ORPHAN");
  });
});
