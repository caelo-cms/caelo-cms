// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _setKekForTests,
  decryptSecret,
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
