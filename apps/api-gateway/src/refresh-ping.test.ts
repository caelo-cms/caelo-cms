// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's refresh ping, as the gateway checks it without the database:
 * a Google-signed ID token of the admin's own service account for this
 * gateway's audience, and nothing else.
 */

import { describe, expect, it } from "bun:test";
import { gatewayRefreshAudience } from "@caelo-cms/shared";
import {
  createRefreshPingVerifier,
  FORCED_KEY_REFRESH_MIN_INTERVAL_MS,
  googleIdTokenKeys,
} from "./refresh-ping.js";
import {
  idTokenTestKey,
  signIdTokenForTests,
  TEST_ADMIN_ACCOUNT,
  testRefreshPingVerifier,
} from "./refresh-ping.test-helpers.js";

const live = gatewayRefreshAudience("production", "live");
const staging = gatewayRefreshAudience("production", "staging");
const key = idTokenTestKey("google-key-1");
const verify = testRefreshPingVerifier(key, live);

describe("the refresh ping's check", () => {
  it("takes the admin's ID token for this gateway", async () => {
    expect(await verify(signIdTokenForTests(key, { aud: live }))).toEqual({ ok: true });
    // Google's other spelling of its issuer.
    expect(
      await verify(signIdTokenForTests(key, { aud: live, iss: "accounts.google.com" })),
    ).toEqual({ ok: true });
  });

  it("refuses anything that is not a token, before any key is looked at", async () => {
    let looked = 0;
    const counting = createRefreshPingVerifier({
      account: TEST_ADMIN_ACCOUNT,
      audience: live,
      keys: async () => {
        looked += 1;
        return { [key.kid]: key.publicPem };
      },
    });
    for (const junk of [null, "", "x", "a.b", "a.b.c.d", `${"a".repeat(5000)}.b.c`, "a b.c.d"]) {
      expect((await counting(junk)).ok).toBe(false);
    }
    expect(looked).toBe(0);
  });

  it("refuses a token another key signed, even under a published kid", async () => {
    const forger = idTokenTestKey(key.kid);
    const verdict = await verify(signIdTokenForTests(forger, { aud: live }));
    expect(verdict.ok).toBe(false);
  });

  it("refuses a key Google does not publish", async () => {
    const verdict = await verify(signIdTokenForTests(idTokenTestKey("other-kid"), { aud: live }));
    expect(verdict).toEqual({ ok: false, reason: "signed with a key Google does not publish" });
  });

  it("refuses the staging gateway's token on the live one, and any other audience", async () => {
    expect((await verify(signIdTokenForTests(key, { aud: staging }))).ok).toBe(false);
    expect(
      (await verify(signIdTokenForTests(key, { aud: "https://example.com/some-service" }))).ok,
    ).toBe(false);
  });

  it("refuses another issuer", async () => {
    const verdict = await verify(
      signIdTokenForTests(key, { aud: live, iss: "https://cloud.google.com/iap" }),
    );
    expect(verdict.ok).toBe(false);
  });

  it("refuses every account but the admin's, and an unverified one", async () => {
    for (const email of [
      "someone@example.com",
      "caelo-test-gateway-sa@acme.iam.gserviceaccount.com",
      null,
    ]) {
      const verdict = await verify(signIdTokenForTests(key, { aud: live, email }));
      expect(verdict).toEqual({ ok: false, reason: "not the admin's service account" });
    }
    expect(await verify(signIdTokenForTests(key, { aud: live, emailVerified: false }))).toEqual({
      ok: false,
      reason: "email not verified",
    });
  });

  it("refuses an expired token and one issued in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      (await verify(signIdTokenForTests(key, { aud: live, iat: now - 7200, exp: now - 3600 }))).ok,
    ).toBe(false);
    expect(
      (await verify(signIdTokenForTests(key, { aud: live, iat: now + 600, exp: now + 4200 }))).ok,
    ).toBe(false);
  });
});

describe("Google's ID-token keys", () => {
  it("are fetched once and reused; a token naming an unknown key refetches at most once a minute", async () => {
    let clock = 1_000_000;
    let fetches = 0;
    const keys = googleIdTokenKeys(
      async () => {
        fetches += 1;
        return { [key.kid]: key.publicPem };
      },
      () => clock,
    );
    const unknown = createRefreshPingVerifier({
      account: TEST_ADMIN_ACCOUNT,
      audience: live,
      keys,
    });
    const junk = signIdTokenForTests(idTokenTestKey("junk-kid"), { aud: live });
    expect((await unknown(junk)).ok).toBe(false);
    // The first look fetches; the unknown kid forces one refetch.
    expect(fetches).toBe(2);
    for (let i = 0; i < 50; i += 1) {
      clock += 100;
      expect((await unknown(junk)).ok).toBe(false);
    }
    expect(fetches).toBe(2);
    clock += FORCED_KEY_REFRESH_MIN_INTERVAL_MS;
    await unknown(junk);
    expect(fetches).toBe(3);
    // A known key needs no fetch at all.
    expect(await unknown(signIdTokenForTests(key, { aud: live }))).toEqual({ ok: true });
    expect(fetches).toBe(3);
  });
});
