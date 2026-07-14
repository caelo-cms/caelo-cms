// SPDX-License-Identifier: MPL-2.0

/**
 * issue #303 — Zod boundary for chat.append_message content.
 *
 * Operators saw bare "Status:" notes: rows persisted with empty bodies.
 * The input schema now rejects empty content for user rows (operator AND
 * origin='system' auto-nudges) and for assistant rows that are neither
 * tool-call shells nor interrupted turns; tool rows stay exempt so
 * tool_use/tool_result pairing can never be broken by a strict boundary
 * (run #10's session-wedge class).
 *
 * Pure schema tests — no database, no adapter.
 */

import { describe, expect, it } from "bun:test";
import { appendChatMessageOp } from "../ops/chat/messages.js";

const SESSION = "3f9a12bc-0000-4000-8000-000000000000";

function parse(input: Record<string, unknown>) {
  return appendChatMessageOp.input.safeParse({ chatSessionId: SESSION, ...input });
}

describe("chat.append_message empty-content boundary (issue #303)", () => {
  it("accepts a normal operator user message", () => {
    expect(parse({ role: "user", content: "hello" }).success).toBe(true);
  });

  it("accepts a non-empty system-origin nudge", () => {
    expect(
      parse({ role: "user", content: "Crawl finished: 12 pages staged.", origin: "system" })
        .success,
    ).toBe(true);
  });

  it("rejects an empty user message", () => {
    const r = parse({ role: "user", content: "" });
    expect(r.success).toBe(false);
  });

  it("rejects a whitespace-only system-origin status note", () => {
    const r = parse({ role: "user", content: "   \n\t ", origin: "system" });
    expect(r.success).toBe(false);
  });

  it("names the producer from the source hint in the rejection", () => {
    const r = parse({
      role: "user",
      content: "",
      origin: "system",
      source: "crawl-wait nudge (ChatPanel)",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join("\n");
      expect(messages).toContain("crawl-wait nudge (ChatPanel)");
      expect(messages).toContain("must not call chat.append_message");
    }
  });

  it("points at the missing source hint when none is provided", () => {
    const r = parse({ role: "user", content: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join("\n")).toContain(
        "pass `source` at the call site",
      );
    }
  });

  it("accepts an empty assistant tool-call shell (text lives in tool_use blocks)", () => {
    const r = parse({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc-1", name: "edit_module", arguments: {} }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts an empty interrupted assistant turn (abort before any text)", () => {
    expect(parse({ role: "assistant", content: "", status: "interrupted" }).success).toBe(true);
  });

  it("rejects an empty completed assistant turn with no tool calls", () => {
    const r = parse({ role: "assistant", content: "", status: "complete" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join("\n")).toContain(
        "empty assistant-message content",
      );
    }
  });

  it("rejects an empty assistant turn with an EMPTY toolCalls array (not a shell)", () => {
    expect(parse({ role: "assistant", content: "", toolCalls: [] }).success).toBe(false);
  });

  it("accepts an empty tool result (pairing-completeness beats strictness)", () => {
    expect(parse({ role: "tool", content: "", toolCallId: "tc-1" }).success).toBe(true);
  });

  it("keeps rejecting unknown keys (strict object)", () => {
    expect(parse({ role: "user", content: "hi", bogus: 1 }).success).toBe(false);
  });

  it("caps the source hint length", () => {
    expect(parse({ role: "user", content: "hi", source: "x".repeat(121) }).success).toBe(false);
    expect(parse({ role: "user", content: "hi", source: "x".repeat(120) }).success).toBe(true);
  });
});
