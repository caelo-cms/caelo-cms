// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { signCsrfToken, verifyCsrfToken } from "../csrf.js";

describe("CSRF HMAC tokens", () => {
  it("verifies a freshly-signed token", async () => {
    const secret = "test-secret-32-chars-long-aaaaaaaa";
    const token = await signCsrfToken(secret);
    expect(await verifyCsrfToken(secret, token)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signCsrfToken("secret-A-32-chars-long-aaaaaaaaaa");
    expect(await verifyCsrfToken("secret-B-32-chars-long-bbbbbbbbbb", token)).toBe(false);
  });

  it("rejects an empty token / empty secret", async () => {
    expect(await verifyCsrfToken("secret", "")).toBe(false);
    expect(await verifyCsrfToken("", "anything")).toBe(false);
  });

  it("rejects a malformed token (wrong number of parts)", async () => {
    const secret = "test-secret-32-chars-long-aaaaaaaa";
    expect(await verifyCsrfToken(secret, "not-a-valid-token")).toBe(false);
    expect(await verifyCsrfToken(secret, "too.many.parts.here.now")).toBe(false);
  });

  it("rejects a token with a tampered timestamp (HMAC mismatch)", async () => {
    const secret = "test-secret-32-chars-long-aaaaaaaa";
    const token = await signCsrfToken(secret);
    const parts = token.split(".");
    const tamperedTs = String(Number(parts[0]) + 1);
    const tampered = `${tamperedTs}.${parts[1]}.${parts[2]}`;
    expect(await verifyCsrfToken(secret, tampered)).toBe(false);
  });

  it("two consecutive sign() calls produce different tokens (per-render rotation)", async () => {
    const secret = "test-secret-32-chars-long-aaaaaaaa";
    const a = await signCsrfToken(secret);
    await new Promise((r) => setTimeout(r, 1));
    const b = await signCsrfToken(secret);
    expect(a).not.toBe(b);
  });
});
