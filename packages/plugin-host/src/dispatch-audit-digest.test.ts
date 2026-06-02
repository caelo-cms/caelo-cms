// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for `auditInputDigest` (packages/plugin-host/src/dispatch.ts).
 *
 * The digest is an audit integrity fingerprint, NOT a password hash. These
 * tests pin the security property the SHA-256-with-redaction fix buys
 * (issue #113, CodeQL js/insufficient-password-hash): a secret value must be
 * invisible to the digest, so the stored `input_hash` can never act as an
 * offline oracle for a credential — while non-secret fields still affect it
 * and the digest stays deterministic for correlation.
 */

import { describe, expect, it } from "bun:test";
import { auditInputDigest } from "./dispatch.js";

const HEX64 = /^[0-9a-f]{64}$/;

describe("auditInputDigest", () => {
  it("returns a 64-char hex SHA-256 digest", () => {
    expect(auditInputDigest({ a: 1 })).toMatch(HEX64);
    expect(auditInputDigest(null)).toMatch(HEX64);
    expect(auditInputDigest(undefined)).toMatch(HEX64);
  });

  it("is deterministic for equal inputs", () => {
    expect(auditInputDigest({ a: 1, b: "x" })).toBe(auditInputDigest({ a: 1, b: "x" }));
  });

  it("hides a top-level secret value (different passwords → same digest)", () => {
    // The whole point: the secret value cannot be brute-forced from the hash.
    expect(auditInputDigest({ password: "hunter2" })).toBe(
      auditInputDigest({ password: "correct-horse" }),
    );
  });

  it("redacts every sensitive-named field shape", () => {
    for (const key of ["password", "passwd", "passphrase", "secret", "apiKey", "api_key", "token", "credential", "privateKey", "private_key"]) {
      expect(auditInputDigest({ [key]: "a" })).toBe(auditInputDigest({ [key]: "b" }));
    }
  });

  it("hides secrets nested in objects and arrays", () => {
    expect(auditInputDigest({ cfg: { password: "a" } })).toBe(
      auditInputDigest({ cfg: { password: "b" } }),
    );
    expect(auditInputDigest([{ secret: "a" }])).toBe(auditInputDigest([{ secret: "b" }]));
  });

  it("still reflects non-secret field values (no over-redaction)", () => {
    expect(auditInputDigest({ slug: "a" })).not.toBe(auditInputDigest({ slug: "b" }));
  });

  it("distinguishes different field names even when both are redacted", () => {
    // Same redacted placeholder value, different keys → different JSON → different digest.
    expect(auditInputDigest({ password: "x" })).not.toBe(auditInputDigest({ token: "x" }));
  });

  it("does not pollute the prototype via a hostile key, and ignores it in the digest", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const digest = auditInputDigest(hostile);
    expect(digest).toMatch(HEX64);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The dropped __proto__ key means this equals the digest of just {ok:1}.
    expect(digest).toBe(auditInputDigest({ ok: 1 }));
  });
});
