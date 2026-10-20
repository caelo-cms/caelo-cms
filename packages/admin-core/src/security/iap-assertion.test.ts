// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the IAP assertion verifier, driven with generated ES256 keys
 * through the key-provider seam (no network): every rejection reason the
 * remote MCP endpoints rely on, plus the happy path.
 */

import { describe, expect, it } from "bun:test";
import {
  createIapVerifier,
  IAP_ISSUER,
  type IapKeyProvider,
  type IapVerificationResult,
} from "./iap-assertion.js";
import { iapTestKeyPair, signIapTestAssertion } from "./iap-assertion.test-helpers.js";

const AUDIENCE = "/projects/123456/locations/europe-west1/services/caelo-admin";
const signer = iapTestKeyPair("kid-1");
const otherSigner = iapTestKeyPair("kid-1");
const keys: IapKeyProvider = async () => ({ "kid-1": signer.publicPem });

function verifier(overrides: { audience?: string | undefined; keys?: IapKeyProvider } = {}) {
  return createIapVerifier({
    audience: () => ("audience" in overrides ? overrides.audience : AUDIENCE),
    keys: overrides.keys ?? keys,
  });
}

function failureKind(r: IapVerificationResult): string {
  return r.ok ? "ok" : r.error.kind;
}

describe("IAP assertion verifier", () => {
  it("accepts a valid assertion and returns the email", async () => {
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE, email: "Editor@Example.com" });
    const r = await verifier()(jwt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.email).toBe("Editor@Example.com");
      expect(r.identity.subject).toBe("accounts.google.com:1234");
    }
  });

  it("rejects a wrong audience", async () => {
    const jwt = signIapTestAssertion(signer, { aud: "/projects/999/global/backendServices/1" });
    expect(failureKind(await verifier()(jwt))).toBe("invalid");
  });

  it("rejects a wrong issuer", async () => {
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE, iss: "https://accounts.google.com" });
    expect(failureKind(await verifier()(jwt))).toBe("invalid");
  });

  it("rejects an assertion expired beyond the 30 s skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    // 60 s past exp: inside the library's own 300 s window, outside ours.
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE, iat: now - 660, exp: now - 60 });
    const r = await verifier()(jwt);
    expect(failureKind(r)).toBe("invalid");
    if (!r.ok && r.error.kind === "invalid") expect(r.error.detail).toBe("expired");
  });

  it("tolerates an assertion within the 30 s skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE, iat: now - 600, exp: now - 10 });
    expect((await verifier()(jwt)).ok).toBe(true);
  });

  it("rejects an assertion issued in the future beyond the skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE, iat: now + 120, exp: now + 600 });
    expect(failureKind(await verifier()(jwt))).toBe("invalid");
  });

  it("rejects a bad signature (same kid, other key)", async () => {
    const jwt = signIapTestAssertion(otherSigner, { aud: AUDIENCE });
    expect(failureKind(await verifier()(jwt))).toBe("invalid");
  });

  it("rejects a tampered payload", async () => {
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE, email: "a@example.com" });
    const [h, , s] = jwt.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        iss: IAP_ISSUER,
        aud: AUDIENCE,
        email: "owner@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    expect(failureKind(await verifier()(`${h}.${forged}.${s}`))).toBe("invalid");
  });

  it("refreshes the key set once for an unknown kid, then rejects", async () => {
    const calls: boolean[] = [];
    const rotating: IapKeyProvider = async ({ forceRefresh }) => {
      calls.push(forceRefresh);
      return { "kid-1": signer.publicPem };
    };
    const jwt = signIapTestAssertion(iapTestKeyPair("kid-unknown"), { aud: AUDIENCE });
    expect(failureKind(await verifier({ keys: rotating })(jwt))).toBe("invalid");
    expect(calls).toEqual([false, true]);
  });

  it("accepts a key that only appears after the forced refresh (rotation)", async () => {
    const rotated = iapTestKeyPair("kid-2");
    let refreshed = false;
    const rotating: IapKeyProvider = async ({ forceRefresh }) => {
      if (forceRefresh) refreshed = true;
      return refreshed ? { "kid-2": rotated.publicPem } : { "kid-1": signer.publicPem };
    };
    const jwt = signIapTestAssertion(rotated, { aud: AUDIENCE });
    expect((await verifier({ keys: rotating })(jwt)).ok).toBe(true);
  });

  it("reports a missing header as missing", async () => {
    expect(failureKind(await verifier()(null))).toBe("missing");
    expect(failureKind(await verifier()(""))).toBe("missing");
  });

  it("rejects garbage", async () => {
    expect(failureKind(await verifier()("not-a-jwt"))).toBe("invalid");
  });

  it("rejects an assertion without an email claim", async () => {
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE, email: null });
    expect(failureKind(await verifier()(jwt))).toBe("invalid");
  });

  it("reports an unset CAELO_IAP_AUDIENCE as not_configured, before looking at the header", async () => {
    const jwt = signIapTestAssertion(signer, { aud: AUDIENCE });
    expect(failureKind(await verifier({ audience: undefined })(jwt))).toBe("not_configured");
    expect(failureKind(await verifier({ audience: "  " })(null))).toBe("not_configured");
  });

  it("never echoes the assertion in its error", async () => {
    const jwt = signIapTestAssertion(otherSigner, { aud: AUDIENCE });
    const r = await verifier()(jwt);
    expect(JSON.stringify(r)).not.toContain(jwt.split(".")[2] as string);
    expect(JSON.stringify(r)).not.toContain(jwt.split(".")[1] as string);
  });
});
