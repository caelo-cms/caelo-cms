// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — the honeypot travels to the server under the kit's one field
 * name, and the server-side check reads that same name. A hand-rolled
 * key on either side is what left the newsletter/comments checks dead.
 */

import { describe, expect, it } from "bun:test";
import { HONEYPOT_FIELD_NAME, honeypotBodyField, isHoneypotArgTripped } from "./index.js";

describe("honeypot round trip", () => {
  it("forwards the raw field under HONEYPOT_FIELD_NAME", () => {
    const fd = new FormData();
    fd.set(HONEYPOT_FIELD_NAME, "123 Bot Street");
    expect(honeypotBodyField(fd)).toEqual({ [HONEYPOT_FIELD_NAME]: "123 Bot Street" });
    expect(honeypotBodyField(new FormData())).toEqual({ [HONEYPOT_FIELD_NAME]: "" });
  });

  it("the server check trips on exactly what the component forwards", () => {
    const filled = new FormData();
    filled.set(HONEYPOT_FIELD_NAME, "x");
    expect(isHoneypotArgTripped({ email: "a@b.c", ...honeypotBodyField(filled) })).toBe(true);
    expect(isHoneypotArgTripped({ email: "a@b.c", ...honeypotBodyField(new FormData()) })).toBe(
      false,
    );
  });

  it("ignores whitespace, non-strings and other keys", () => {
    expect(isHoneypotArgTripped({ [HONEYPOT_FIELD_NAME]: "   " })).toBe(false);
    expect(isHoneypotArgTripped({ [HONEYPOT_FIELD_NAME]: 1 })).toBe(false);
    expect(isHoneypotArgTripped({ honeypot: "x" })).toBe(false);
    expect(isHoneypotArgTripped(null)).toBe(false);
  });
});
