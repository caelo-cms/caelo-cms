// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { stepUpProblem } from "./gate.js";
import {
  authorizationUrl,
  exchangeCode,
  GOOGLE_TOKEN_ENDPOINT,
  newChallengeSecrets,
  verifyFreshSignIn,
} from "./google-oidc.js";

const CLIENT = "123-abc.apps.googleusercontent.com";
const NOW = 1_800_000_000;

function token(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

const good = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  exp: NOW + 3600,
  nonce: "n-1",
  email: "Owner@Example.com",
  email_verified: true,
  auth_time: NOW - 5,
};
const expect_ = { clientId: CLIENT, nonce: "n-1", startedAtSec: NOW - 60, nowSec: NOW };

describe("verifyFreshSignIn", () => {
  it("accepts a fresh sign-in and lower-cases the email", () => {
    expect(verifyFreshSignIn(token(good), expect_)).toEqual({
      ok: true,
      value: { email: "owner@example.com", authTime: NOW - 5, nonce: "n-1" },
    });
  });

  it.each([
    ["not a JWT", "garbage", "could not be read"],
    ["foreign issuer", token({ ...good, iss: "https://evil.example" }), "not issued by Google"],
    ["other audience", token({ ...good, aud: "other" }), "different OAuth client"],
    ["multi-aud without azp", token({ ...good, aud: [CLIENT, "x"] }), "authorized party"],
    ["expired", token({ ...good, exp: NOW - 120 }), "expired"],
    ["nonce mismatch", token({ ...good, nonce: "other" }), "nonce mismatch"],
    ["unverified email", token({ ...good, email_verified: false }), "verified email"],
    ["no auth_time", token({ ...good, auth_time: undefined }), "no auth_time"],
    ["reused session", token({ ...good, auth_time: NOW - 3600 }), "reused an earlier sign-in"],
    ["future auth_time", token({ ...good, auth_time: NOW + 600 }), "future"],
  ])("refuses: %s", (_name, idToken, why) => {
    const r = verifyFreshSignIn(idToken, expect_);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain(why);
  });
});

describe("authorizationUrl", () => {
  it("asks Google for a re-authentication with PKCE", async () => {
    const s = await newChallengeSecrets();
    expect(s.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(
      authorizationUrl({
        clientId: CLIENT,
        redirectUri: "https://admin.example.com/cb",
        state: s.state,
        nonce: s.nonce,
        codeChallenge: s.codeChallenge,
        loginHint: "owner@example.com",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      scope: "openid email",
      max_age: "0",
      code_challenge_method: "S256",
      code_challenge: s.codeChallenge,
      login_hint: "owner@example.com",
    });
  });
});

describe("exchangeCode", () => {
  const opts = {
    clientId: CLIENT,
    clientSecret: "s",
    code: "c",
    codeVerifier: "v",
    redirectUri: "https://admin.example.com/cb",
  };

  it("posts the code + verifier to Google's fixed token endpoint", async () => {
    const calls: { url: string; body: string }[] = [];
    const r = await exchangeCode(async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ id_token: "t" }), { status: 200 });
    }, opts);
    expect(r).toEqual({ ok: true, value: "t" });
    expect(calls[0]?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(new URLSearchParams(calls[0]?.body).get("code_verifier")).toBe("v");
  });

  it("explains a rejected client and a network failure", async () => {
    const bad = await exchangeCode(
      async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
      opts,
    );
    expect(bad.ok ? "" : bad.reason).toContain("Check the client ID and secret");
    const down = await exchangeCode(async () => {
      throw new Error("ENOTFOUND");
    }, opts);
    expect(down.ok ? "" : down.reason).toContain("could not be reached");
  });
});

describe("stepUpProblem", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const session = {
    userEmail: "owner@example.com",
    stepUpAt: new Date("2026-10-13T11:58:00Z"),
    stepUpEmail: "owner@example.com",
  };
  it("fresh and matching → null", () => {
    expect(stepUpProblem(session, now)).toBeNull();
  });
  it.each([
    ["no session", null, "not signed in"],
    ["never stepped up", { ...session, stepUpAt: null }, "no Google sign-in"],
    ["stale", { ...session, stepUpAt: new Date("2026-10-13T11:40:00Z") }, "20 minutes ago"],
    ["other account", { ...session, stepUpEmail: "x@example.com" }, "is not owner@example.com"],
  ])("%s", (_n, s, why) => {
    expect(stepUpProblem(s, now)).toContain(why);
  });
});
