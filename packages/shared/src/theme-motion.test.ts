// SPDX-License-Identifier: MPL-2.0

/**
 * A live build turn failed on `set_theme_tokens` because the `motion`
 * token accepted only a DTCG duration, a `cubicBezier` [x1,y1,x2,y2]
 * tuple, or a dimension — NOT the CSS easing forms a model naturally
 * emits for `motion.easing` (a keyword like `ease-in-out`, or a literal
 * `cubic-bezier(0.4, 0, 0.2, 1)` string). The rejection message was a
 * bare "motion token invalid: Invalid input" that told the model
 * nothing about the accepted shape (CLAUDE.md §11 — AI-actionable
 * errors). This pins the loosened validation + the actionable message.
 */

import { describe, expect, it } from "bun:test";
import { themeDocument } from "./themes.js";

function docWithMotion(name: string, value: unknown): unknown {
  return {
    color: { primary: { $type: "color", $value: "#4f46e5" } },
    motion: { [name]: { $value: value } },
  };
}

describe("motion.easing accepts the common CSS easing forms", () => {
  it("accepts every CSS easing keyword", () => {
    for (const kw of [
      "linear",
      "ease",
      "ease-in",
      "ease-out",
      "ease-in-out",
      "step-start",
      "step-end",
    ]) {
      const r = themeDocument.safeParse(docWithMotion("easing", kw));
      expect(r.success).toBe(true);
    }
  });

  it("accepts a literal cubic-bezier(...) string", () => {
    for (const v of ["cubic-bezier(0.4, 0, 0.2, 1)", "cubic-bezier(.25,.1,.25,1)"]) {
      expect(themeDocument.safeParse(docWithMotion("easing", v)).success).toBe(true);
    }
  });

  it("accepts a steps(...) timing function", () => {
    expect(themeDocument.safeParse(docWithMotion("easing", "steps(4, end)")).success).toBe(true);
  });

  it("still accepts the DTCG cubicBezier tuple, a duration, and an alias", () => {
    expect(themeDocument.safeParse(docWithMotion("ease", [0.4, 0, 0.2, 1])).success).toBe(true);
    expect(themeDocument.safeParse(docWithMotion("fast", "200ms")).success).toBe(true);
    expect(themeDocument.safeParse(docWithMotion("smooth", "{motion.ease}")).success).toBe(true);
  });
});

describe("motion tokens reject junk loudly with an actionable message", () => {
  it("rejects a number, a boolean, and an empty string", () => {
    for (const v of [42, true, ""]) {
      expect(themeDocument.safeParse(docWithMotion("easing", v)).success).toBe(false);
    }
  });

  it("rejects a bogus keyword", () => {
    expect(themeDocument.safeParse(docWithMotion("easing", "wobble")).success).toBe(false);
  });

  it("the rejection message names the token, the accepted shapes, and the value", () => {
    const r = themeDocument.safeParse(docWithMotion("easing", 42));
    expect(r.success).toBe(false);
    if (r.success) return;
    const msg = r.error.issues[0]!.message;
    expect(msg).toContain('motion token "easing" invalid');
    expect(msg).toContain('expected a duration (e.g. "200ms")');
    expect(msg).toContain("cubic-bezier(...)");
    expect(msg).toContain("ease-in-out");
    expect(msg).toContain("got 42");
    // The old vague text must be gone.
    expect(msg).not.toContain("Invalid input");
  });
});

/**
 * 2026-07-28 — a model wrote `motion: "180ms ease"`, the CSS transition
 * shorthand. Listing the accepted forms did not tell it what was actually
 * wrong (two tokens in one string), so it took three attempts to correct —
 * and, because gated proposals were validated only AFTER approval, three
 * operator clicks. The message now names the mistake.
 */
describe("a CSS shorthand names the real mistake, not just the legal forms", () => {
  it("tells the caller to split duration and easing", () => {
    const r = themeDocument.safeParse(docWithMotion("motion", "180ms ease"));
    expect(r.success).toBe(false);
    if (r.success) return;
    const msg = r.error.issues[0]!.message;
    expect(msg).toContain("CSS transition shorthand");
    expect(msg).toContain('put "180ms" in a duration token');
    expect(msg).toContain('"ease" in an easing token');
  });

  it("covers the seconds form too", () => {
    const r = themeDocument.safeParse(docWithMotion("motion", "0.2s ease-in-out"));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]!.message).toContain('put "0.2s" in a duration token');
  });

  it("stays silent when the value is not a shorthand", () => {
    // A plain bad value must not get a shorthand lecture it cannot act on.
    const r = themeDocument.safeParse(docWithMotion("motion", "banana"));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]!.message).not.toContain("shorthand");
  });
});
