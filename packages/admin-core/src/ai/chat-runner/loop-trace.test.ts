// SPDX-License-Identifier: MPL-2.0

/**
 * The per-loop trace exists to LOCATE a cache miss, so its fingerprints must
 * change exactly when the provider would see a different prefix, and not
 * otherwise. These tests pin the three cases that mattered on 2026-07-27:
 * a dropped image, an edited message, and an honest append.
 */

import { describe, expect, it } from "bun:test";

import { fingerprintMessages, firstPrefixDivergence, hashOf, loopTracePath } from "./loop-trace.js";

const msg = (role: string, content: string, images = 0) => ({
  role,
  content,
  ...(images > 0
    ? { additionalContent: Array.from({ length: images }, () => ({ type: "image" as const })) }
    : {}),
});

describe("loopTracePath", () => {
  it("is off unless explicitly enabled", () => {
    const prev = process.env.CAELO_CHAT_TRACE;
    process.env.CAELO_CHAT_TRACE = undefined as unknown as string;
    // biome-ignore lint/performance/noDelete: restoring env for the assertion
    delete process.env.CAELO_CHAT_TRACE;
    expect(loopTracePath()).toBeNull();
    if (prev !== undefined) process.env.CAELO_CHAT_TRACE = prev;
  });
});

describe("fingerprintMessages", () => {
  it("counts image parts per message and in total", () => {
    const { fingerprints, totalImageParts } = fingerprintMessages([
      msg("user", "build the footer"),
      msg("user", "[Screenshot returned by screenshot_page]", 1),
      msg("user", "two shots", 2),
    ]);
    expect(fingerprints.map((f) => f.images)).toEqual([0, 1, 2]);
    expect(totalImageParts).toBe(3);
  });

  it("keeps the tool call id so a re-pairing is visible", () => {
    const { fingerprints } = fingerprintMessages([
      { role: "tool", content: "done", toolCallId: "toolu_1" },
    ]);
    expect(fingerprints[0]?.toolCallId).toBe("toolu_1");
  });
});

describe("firstPrefixDivergence", () => {
  it("returns null for an honest append — the healthy case", () => {
    const before = fingerprintMessages([msg("user", "a"), msg("assistant", "b")]).fingerprints;
    const after = fingerprintMessages([
      msg("user", "a"),
      msg("assistant", "b"),
      msg("tool", "c"),
    ]).fingerprints;
    expect(firstPrefixDivergence(before, after)).toBeNull();
  });

  it("names the message whose IMAGE was dropped", () => {
    // The exact shape of today's runtime-only screenshot behaviour: the text
    // survives the rebuild, the image part does not. Provider-side that is an
    // image removal, which invalidates the message cache from here on.
    const before = fingerprintMessages([
      msg("user", "a"),
      msg("user", "[Screenshot]", 1),
      msg("assistant", "c"),
    ]).fingerprints;
    const after = fingerprintMessages([
      msg("user", "a"),
      msg("user", "[Screenshot]", 0),
      msg("assistant", "c"),
    ]).fingerprints;
    expect(firstPrefixDivergence(before, after)).toBe(1);
  });

  it("names the message whose text was rewritten (compaction, repair)", () => {
    const before = fingerprintMessages([msg("user", "a"), msg("tool", "full result")]).fingerprints;
    const after = fingerprintMessages([msg("user", "a"), msg("tool", "trunc…")]).fingerprints;
    expect(firstPrefixDivergence(before, after)).toBe(1);
  });

  it("names index 0 when the head itself changed", () => {
    const before = fingerprintMessages([msg("user", "a"), msg("user", "b")]).fingerprints;
    const after = fingerprintMessages([msg("user", "z"), msg("user", "b")]).fingerprints;
    expect(firstPrefixDivergence(before, after)).toBe(0);
  });
});

describe("hashOf", () => {
  it("is stable for equal values and differs on reordering", () => {
    expect(hashOf(["a", "b"])).toBe(hashOf(["a", "b"]));
    // A reordered tool array is a different prefix to the provider, so the
    // hash must not treat it as equal.
    expect(hashOf(["a", "b"])).not.toBe(hashOf(["b", "a"]));
  });
});
