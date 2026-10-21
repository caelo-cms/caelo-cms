// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _setKekForTests,
  decryptSecret,
  deriveKekSubkey,
  encryptSecret,
  generateKekHex,
  kekFingerprint,
} from "./secret-box.js";

const KEK_A = new Uint8Array(32).fill(0x11);
const KEK_B = new Uint8Array(32).fill(0x22);

describe("secret-box", () => {
  beforeEach(() => _setKekForTests(KEK_A));
  afterEach(() => _setKekForTests(null));

  it("round-trips a UTF-8 string", async () => {
    const enc = await encryptSecret("sk-ant-abcdef-1234567890");
    expect(enc.ciphertext.length).toBeGreaterThan(0);
    expect(enc.iv.length).toBe(12);
    const out = await decryptSecret(enc);
    expect(out).toBe("sk-ant-abcdef-1234567890");
  });

  it("uses a fresh IV per call (no IV reuse)", async () => {
    const a = await encryptSecret("same plaintext");
    const b = await encryptSecret("same plaintext");
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("kekFingerprint is stable for a given KEK", async () => {
    const fp1 = await kekFingerprint();
    const fp2 = await kekFingerprint();
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{8}$/);
  });

  it("kekFingerprint differs across KEKs", async () => {
    const fpA = await kekFingerprint();
    _setKekForTests(KEK_B);
    const fpB = await kekFingerprint();
    expect(fpA).not.toBe(fpB);
  });

  it("decrypt rejects ciphertext encrypted under a different KEK", async () => {
    const enc = await encryptSecret("hidden");
    _setKekForTests(KEK_B); // rotate
    await expect(decryptSecret(enc)).rejects.toThrow(/different KEK/);
  });

  it("generateKekHex produces 64 hex chars", () => {
    const hex = generateKekHex();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // Different on each call.
    expect(hex).not.toBe(generateKekHex());
  });
});

describe("deriveKekSubkey (#946)", () => {
  afterEach(() => _setKekForTests(null));
  const msg = new TextEncoder().encode("payload");
  const sign = async (label: string) =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await deriveKekSubkey(label), msg));

  it("is stable per KEK + label and independent across labels and KEKs", async () => {
    _setKekForTests(KEK_A);
    const a1 = await sign("caelo/test/v1");
    expect(await sign("caelo/test/v1")).toEqual(a1);
    expect(await sign("caelo/other/v1")).not.toEqual(a1);
    // A signature verifies only under the key it was made with.
    const key = await deriveKekSubkey("caelo/test/v1");
    expect(await crypto.subtle.verify("HMAC", key, a1, msg)).toBe(true);
    _setKekForTests(KEK_B);
    expect(await sign("caelo/test/v1")).not.toEqual(a1);
  });

  it("fails loudly without a KEK", async () => {
    _setKekForTests(null);
    const saved = process.env.CAELO_SECRET_KEK;
    delete process.env.CAELO_SECRET_KEK;
    try {
      await expect(deriveKekSubkey("caelo/test/v1")).rejects.toThrow(/CAELO_SECRET_KEK is not set/);
    } finally {
      if (saved !== undefined) process.env.CAELO_SECRET_KEK = saved;
    }
  });
});
