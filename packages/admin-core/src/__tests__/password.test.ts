// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { hashPassword, verifyPassword } from "../password.js";

describe("password hashing", () => {
  it("produces an argon2id-prefixed hash and verifies the original", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("refuses to hash a too-short password", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 8/);
  });

  it("verifies two different hashes of the same password independently", async () => {
    const a = await hashPassword("same-plain-8chars");
    const b = await hashPassword("same-plain-8chars");
    expect(a).not.toBe(b); // salts differ
    expect(await verifyPassword("same-plain-8chars", a)).toBe(true);
    expect(await verifyPassword("same-plain-8chars", b)).toBe(true);
  });

  it("treats a malformed hash as a mismatch (no crash)", async () => {
    expect(await verifyPassword("any", "not-a-real-hash")).toBe(false);
  });
});
