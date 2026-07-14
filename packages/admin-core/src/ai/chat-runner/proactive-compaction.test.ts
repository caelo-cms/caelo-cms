// SPDX-License-Identifier: MPL-2.0

/**
 * issue #300 part B — unit tests for the proactive tool-result
 * compaction: the age/size/never-compact predicate, the summary shape
 * (head + key ids + shared truncation marker), and the pure
 * history-rewrite that only touches current-turn results.
 */

import { describe, expect, it } from "bun:test";

import type { ChatMessageInput } from "../provider.js";
import {
  compactOldToolResults,
  PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS,
  PROACTIVE_TOOL_RESULT_MIN_CHARS,
  shouldCompactToolResult,
  summarizeToolResult,
  type ToolResultOrigin,
} from "./proactive-compaction.js";

const BIG = 5000;

function bigOkResult(): string {
  return `ok: module created (id=hero-1)\n${"<div>".repeat(BIG / 5)}`;
}

describe("shouldCompactToolResult", () => {
  const base = {
    content: bigOkResult(),
    ok: true,
    originLoop: 0,
    currentLoop: PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS,
  };

  it("compacts a successful, old, large, unmarked result", () => {
    expect(shouldCompactToolResult(base)).toBe(true);
  });

  it("never compacts failed results — the AI may need the full error", () => {
    expect(shouldCompactToolResult({ ...base, ok: false })).toBe(false);
  });

  it("never compacts results from the current or the previous loop", () => {
    expect(shouldCompactToolResult({ ...base, originLoop: 3, currentLoop: 3 })).toBe(false);
    expect(shouldCompactToolResult({ ...base, originLoop: 2, currentLoop: 3 })).toBe(false);
    // Even with a (misconfigured) minAgeLoops of 0/1, the floor of 2 holds.
    expect(
      shouldCompactToolResult({ ...base, originLoop: 3, currentLoop: 3, minAgeLoops: 0 }),
    ).toBe(false);
    expect(
      shouldCompactToolResult({ ...base, originLoop: 2, currentLoop: 3, minAgeLoops: 1 }),
    ).toBe(false);
  });

  it("respects the default age threshold exactly", () => {
    expect(
      shouldCompactToolResult({
        ...base,
        originLoop: 0,
        currentLoop: PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS - 1,
      }),
    ).toBe(false);
    expect(
      shouldCompactToolResult({
        ...base,
        originLoop: 0,
        currentLoop: PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS,
      }),
    ).toBe(true);
  });

  it("skips small results at or under the size threshold", () => {
    expect(
      shouldCompactToolResult({ ...base, content: "x".repeat(PROACTIVE_TOOL_RESULT_MIN_CHARS) }),
    ).toBe(false);
    expect(
      shouldCompactToolResult({
        ...base,
        content: "x".repeat(PROACTIVE_TOOL_RESULT_MIN_CHARS + 1),
      }),
    ).toBe(true);
  });

  it("skips results already carrying the #261 truncation marker", () => {
    const alreadyCut = `${"y".repeat(3000)}\n[truncated: 40000 chars]`;
    expect(shouldCompactToolResult({ ...base, content: alreadyCut })).toBe(false);
  });
});

describe("summarizeToolResult", () => {
  it("keeps the leading line, appends key identifiers and the shared marker", () => {
    const uuid = "a1b2c3d4-e5f6-4a1b-8c2d-0123456789ab";
    const content = `ok: page built\n${"<section>filler</section>".repeat(200)}{"pageId":"${uuid}","slug":"pricing"}`;
    const summary = summarizeToolResult(content);

    const lines = summary.split("\n");
    expect(lines[0]).toBe("ok: page built");
    // Key ids pulled from deep in the body.
    expect(summary).toContain(uuid);
    expect(summary).toContain("pricing");
    // Shared truncation-marker format, counting the dropped chars.
    expect(summary).toMatch(/\[truncated: \d+ chars\]$/);
    expect(summary.length).toBeLessThan(content.length);
  });

  it("caps an endless single-line body at the summary head", () => {
    const content = "z".repeat(10_000);
    const summary = summarizeToolResult(content);
    expect(summary.length).toBeLessThan(500);
    expect(summary).toMatch(/\[truncated: \d+ chars\]$/);
  });
});

describe("compactOldToolResults", () => {
  function history(): ChatMessageInput[] {
    return [
      { role: "user", content: "migrate the site" },
      // Pre-turn tool result — NOT in the origins map; must pass through.
      { role: "tool", content: `prior-turn ${"P".repeat(BIG)}`, toolCallId: "t-prior" },
      { role: "tool", content: bigOkResult(), toolCallId: "t-old-ok" },
      { role: "tool", content: `err: boom ${"E".repeat(BIG)}`, toolCallId: "t-old-err" },
      { role: "tool", content: bigOkResult(), toolCallId: "t-recent" },
      { role: "assistant", content: "next step" },
    ];
  }
  const origins = new Map<string, ToolResultOrigin>([
    ["t-old-ok", { loop: 0, ok: true }],
    ["t-old-err", { loop: 0, ok: false }],
    ["t-recent", { loop: 3, ok: true }],
  ]);

  it("compacts only old successful current-turn results; is pure", () => {
    const input = history();
    const inputSnapshot = structuredClone(input);
    const { messages, compacted, charsSaved } = compactOldToolResults(input, {
      currentLoop: 4,
      origins,
    });

    // Input untouched (pure).
    expect(input).toEqual(inputSnapshot);

    expect(compacted).toBe(1);
    expect(charsSaved).toBeGreaterThan(BIG - 500);
    // Old ok result → summary with the shared marker.
    expect(messages[2]?.content).toMatch(/\[truncated: \d+ chars\]$/);
    expect(messages[2]?.content.length).toBeLessThan(1000);
    // Failed result, recent result, and pre-turn (non-origin) result verbatim.
    expect(messages[3]?.content).toBe(input[3]?.content ?? "");
    expect(messages[4]?.content).toBe(input[4]?.content ?? "");
    expect(messages[1]?.content).toBe(input[1]?.content ?? "");
    // Non-tool messages pass through by reference.
    expect(messages[0]).toBe(input[0] as ChatMessageInput);
  });

  it("is idempotent — a second pass never re-cuts its own summaries", () => {
    const first = compactOldToolResults(history(), { currentLoop: 4, origins });
    const second = compactOldToolResults(first.messages, { currentLoop: 5, origins });
    expect(second.compacted).toBe(0);
    expect(second.messages[2]?.content).toBe(first.messages[2]?.content ?? "");
  });

  it("compacts the recent result too once it ages past the threshold", () => {
    const { messages, compacted } = compactOldToolResults(history(), {
      currentLoop: 3 + PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS,
      origins,
    });
    expect(compacted).toBe(2);
    expect(messages[4]?.content).toMatch(/\[truncated: \d+ chars\]$/);
  });
});
