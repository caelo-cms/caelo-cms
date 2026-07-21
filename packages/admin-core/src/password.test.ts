// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { MIN_PASSWORD_LENGTH, validatePasswordStrength } from "./password.js";

describe("validatePasswordStrength", () => {
  it("accepts a long, non-obvious password", () => {
    expect(validatePasswordStrength("purple-hatstand-92").ok).toBe(true);
    expect(validatePasswordStrength("myS3cretPhrase!").ok).toBe(true);
  });

  it("rejects anything shorter than the minimum length", () => {
    const r = validatePasswordStrength("Ab3$xz9"); // 7 chars
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("rejects passwords at exactly length-1 but accepts at the floor", () => {
    expect(validatePasswordStrength("abcqwe12z").ok).toBe(false); // 9
    expect(validatePasswordStrength("abcqwe12zk").ok).toBe(true); // 10, not common/seq
  });

  it("rejects known-common passwords (case-insensitively)", () => {
    for (const pw of ["password123", "letmein123", "welcome123", "admin12345", "PassW0rd123"]) {
      const r = validatePasswordStrength(pw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.toLowerCase()).toContain("common");
    }
  });

  it("rejects a single repeated character", () => {
    // `zzzzzzzzzz` isn't in the common-list, so this exercises the repeat rule.
    const r = validatePasswordStrength("zzzzzzzzzz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain("repeated");
  });

  it("rejects pure keyboard / number sequences", () => {
    for (const pw of ["1234567890", "abcdefghij", "qwertyuiop", "0987654321"]) {
      expect(validatePasswordStrength(pw).ok).toBe(false);
    }
  });

  it("does NOT reject a password that merely CONTAINS a short run", () => {
    // `abc` is a substring of the alphabet, but the whole string isn't — allow it.
    expect(validatePasswordStrength("my-abc-castle-7").ok).toBe(true);
  });

  it("rejects a password embedding the account email local-part", () => {
    const r = validatePasswordStrength("michael-rocks-1", { email: "michael@example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain("email");
  });

  it("rejects a password embedding the display name", () => {
    const r = validatePasswordStrength("goforthandersen", { displayName: "Anders Andersen" });
    expect(r.ok).toBe(false);
  });

  it("ignores personal tokens shorter than 4 chars (too generic to block on)", () => {
    // local-part "an" is only 2 chars — must not block an otherwise-fine password.
    expect(validatePasswordStrength("banana-tractor-5", { email: "an@x.io" }).ok).toBe(true);
  });

  it("rejects an over-long password", () => {
    expect(validatePasswordStrength("a1B".repeat(100)).ok).toBe(false); // 300 chars
  });
});
