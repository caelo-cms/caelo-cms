// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for `sanitizeMarkerDisplayName` (issue #113, S7 — the
 * js/incomplete-sanitization must-fix). The display name is interpolated
 * into `<!-- BEGIN module=… displayName="…" -->` markers the chat-runner
 * feeds back to the AI; a name must not be able to break out of the
 * comment or the quoted attribute.
 */

import { describe, expect, it } from "bun:test";
import { sanitizeMarkerDisplayName } from "./marker-text.js";

describe("sanitizeMarkerDisplayName", () => {
  it("escapes a backslash BEFORE the quote (no closing-quote escape)", () => {
    // A trailing backslash must not survive to escape the marker's closing `"`.
    const out = sanitizeMarkerDisplayName("logo\\");
    expect(out).toBe("logo\\\\");
    // Inside displayName="<out>" the run is an even number of backslashes,
    // so the closing quote is not escaped.
    expect(`displayName="${out}"`.endsWith('\\\\"')).toBe(true);
  });

  it("escapes embedded quotes", () => {
    expect(sanitizeMarkerDisplayName('Hero "X"')).toBe('Hero \\"X\\"');
  });

  it("cannot emit a comment-closing --> from the name", () => {
    const out = sanitizeMarkerDisplayName("end --> evil");
    expect(out).not.toContain("--");
    expect(out).not.toContain("-->");
  });

  it("strips raw angle brackets and newlines that break the marker", () => {
    const out = sanitizeMarkerDisplayName("a<b>c\nd\re");
    expect(out).not.toMatch(/[<>\r\n]/);
  });

  it("is behaviour-preserving for an ordinary name", () => {
    expect(sanitizeMarkerDisplayName("Primary Button")).toBe("Primary Button");
  });

  it("neutralizes a combined breakout attempt", () => {
    const out = sanitizeMarkerDisplayName('Hero" --><script>alert(1)</script>');
    expect(out).not.toContain("-->");
    expect(out).not.toMatch(/[<>]/);
    // The quote is escaped, not raw.
    expect(out).not.toMatch(/(^|[^\\])"/);
  });
});
