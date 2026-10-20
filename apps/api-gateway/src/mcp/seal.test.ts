// SPDX-License-Identifier: MPL-2.0

/** #806 — sealed values: confidentiality, integrity, purpose binding, expiry, key ids. */

import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { keyId, open, seal } from "./seal.js";

const KEY = new Uint8Array(randomBytes(32));
const NOW = 1_800_000_000;
const Schema = z.object({ a: z.string(), exp: z.number().optional() });

describe("seal/open", () => {
  it("round-trips and hides the payload", () => {
    const s = seal(KEY, "code", { a: "google-code-secret", exp: NOW + 60 });
    expect(s).toStartWith(`v2.${keyId(KEY)}.`);
    expect(s).not.toContain("google-code-secret");
    expect(Buffer.from(s.split(".")[3] ?? "", "base64url").toString("utf8")).not.toContain(
      "google",
    );
    const o = open(KEY, "code", s, Schema, NOW);
    expect(o).toEqual({ ok: true, value: { a: "google-code-secret", exp: NOW + 60 } });
  });

  it("refuses a value sealed for another purpose (state used as code, consent as state…)", () => {
    const state = seal(KEY, "state", { a: "x", exp: NOW + 60 });
    expect(open(KEY, "code", state, Schema, NOW)).toEqual({ ok: false, reason: "forged" });
    const client = seal(KEY, "client", { a: "x" });
    expect(open(KEY, "refresh", client, Schema, NOW)).toEqual({ ok: false, reason: "forged" });
    const consent = seal(KEY, "consent", { a: "x", exp: NOW + 60 });
    expect(open(KEY, "state", consent, Schema, NOW)).toEqual({ ok: false, reason: "forged" });
  });

  it("refuses a tampered value", () => {
    const s = seal(KEY, "code", { a: "x", exp: NOW + 60 });
    const [v, kid, iv, body] = s.split(".") as [string, string, string, string];
    const bytes = Buffer.from(body, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(
      open(KEY, "code", `${v}.${kid}.${iv}.${bytes.toString("base64url")}`, Schema, NOW).ok,
    ).toBe(false);
    const ivBytes = Buffer.from(iv, "base64url");
    ivBytes[0] = (ivBytes[0] ?? 0) ^ 1;
    expect(
      open(KEY, "code", `${v}.${kid}.${ivBytes.toString("base64url")}.${body}`, Schema, NOW).ok,
    ).toBe(false);
  });

  it("refuses a value sealed under another key, even when its kid is swapped for ours", () => {
    const other = new Uint8Array(randomBytes(32));
    const foreign = seal(other, "code", { a: "x" });
    expect(open(KEY, "code", foreign, Schema, NOW)).toEqual({ ok: false, reason: "forged" });
    const relabelled = foreign.replace(`.${keyId(other)}.`, `.${keyId(KEY)}.`);
    expect(open(KEY, "code", relabelled, Schema, NOW)).toEqual({ ok: false, reason: "forged" });
  });

  it("opens a value sealed under the previous key while it is in the key ring", () => {
    const previous = new Uint8Array(randomBytes(32));
    const old = seal(previous, "refresh", { a: "x" });
    expect(open([KEY, previous], "refresh", old, Schema, NOW)).toEqual({
      ok: true,
      value: { a: "x" },
    });
    expect(open([KEY], "refresh", old, Schema, NOW).ok).toBe(false);
    expect(open([KEY, previous], "refresh", seal(KEY, "refresh", { a: "y" }), Schema, NOW).ok).toBe(
      true,
    );
  });

  it("refuses an expired value", () => {
    const s = seal(KEY, "code", { a: "x", exp: NOW });
    expect(open(KEY, "code", s, Schema, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(open(KEY, "code", s, Schema, NOW - 1).ok).toBe(true);
  });

  it("refuses malformed envelopes and unknown versions", () => {
    for (const bad of [
      "",
      "v2",
      "v2...",
      "v1.a.b",
      "v2.k.a.b.c",
      "v2.k.!!.@@",
      `v2.k.${"A".repeat(9000)}.b`,
    ]) {
      expect(open(KEY, "code", bad, Schema, NOW).ok).toBe(false);
    }
    const s = seal(KEY, "code", { a: "x" });
    expect(open(KEY, "code", s.replace(/^v2/, "v1"), Schema, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a payload that does not fit the schema", () => {
    const s = seal(KEY, "code", { b: 1 });
    expect(open(KEY, "code", s, Schema, NOW)).toEqual({ ok: false, reason: "invalid_payload" });
  });
});
