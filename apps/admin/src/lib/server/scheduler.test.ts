// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — who may call `POST /api/internal/scheduler/tick`:
 *
 *   - the scheduler's own service account through IAP (its verified
 *     assertion, `CAELO_SCHEDULER_SERVICE_ACCOUNT`);
 *   - the internal token of scope `scheduler.tick` (the self-hosted clock,
 *     whose token must verify here);
 *   - nobody else: another IAP identity, a forged assertion, a token of
 *     another scope, no credential.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createIapVerifier,
  IAP_ASSERTION_HEADER,
  iapTestKeyPairForTests,
  mintTickToken,
  setIapVerifierForTests,
  signIapTestAssertionForTests,
} from "@caelo-cms/admin-core";
import { signInternalToken } from "./internal-jwt.js";
import { authorizeSchedulerTick, SCHEDULER_SERVICE_ACCOUNT_ENV } from "./scheduler.js";

const SECRET = "s".repeat(40);
const AUDIENCE = "/projects/42/locations/europe-west1/services/caelo-production-admin";
const SCHEDULER_SA = "caelo-production-scheduler@p.iam.gserviceaccount.com";
const KEY = iapTestKeyPairForTests("k1");
const OTHER_KEY = iapTestKeyPairForTests("k1");
const env = { [SCHEDULER_SERVICE_ACCOUNT_ENV]: SCHEDULER_SA };

const saved = process.env.CAELO_INTERNAL_SECRET;
beforeAll(() => {
  process.env.CAELO_INTERNAL_SECRET = SECRET;
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => AUDIENCE,
      keys: async () => ({ [KEY.kid]: KEY.publicPem }),
    }),
  );
});
afterAll(() => {
  setIapVerifierForTests(null);
  if (saved === undefined) delete process.env.CAELO_INTERNAL_SECRET;
  else process.env.CAELO_INTERNAL_SECRET = saved;
});

const tickRequest = (headers: Record<string, string>) =>
  new Request("https://admin.example.com/api/internal/scheduler/tick", {
    method: "POST",
    headers,
  });

/** The refusal's status, or who was let in. A thrown value fails the test (#1563). */
async function status(p: ReturnType<typeof authorizeSchedulerTick>): Promise<number | string> {
  const auth = await p;
  return auth.ok ? auth.via : auth.refusal.status;
}

describe("authorizeSchedulerTick (#1140)", () => {
  it("lets the scheduler's service account in through IAP", async () => {
    const assertion = signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email: SCHEDULER_SA });
    // Through IAP `Authorization` carries the workflow's IAP credential, not an internal token.
    const req = tickRequest({ [IAP_ASSERTION_HEADER]: assertion, authorization: "Bearer jwt" });
    expect(await status(authorizeSchedulerTick(req, env))).toBe("scheduler-identity");
  });

  it("refuses another IAP identity without the internal token", async () => {
    const assertion = signIapTestAssertionForTests(KEY, {
      aud: AUDIENCE,
      email: "someone@example.com",
    });
    expect(
      await status(authorizeSchedulerTick(tickRequest({ [IAP_ASSERTION_HEADER]: assertion }), env)),
    ).toBe(401);
  });

  it("refuses a forged assertion naming the scheduler", async () => {
    const forged = signIapTestAssertionForTests(OTHER_KEY, { aud: AUDIENCE, email: SCHEDULER_SA });
    expect(
      await status(authorizeSchedulerTick(tickRequest({ [IAP_ASSERTION_HEADER]: forged }), env)),
    ).toBe(401);
  });

  it("ignores the scheduler identity where no scheduler account is configured", async () => {
    const assertion = signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email: SCHEDULER_SA });
    expect(
      await status(authorizeSchedulerTick(tickRequest({ [IAP_ASSERTION_HEADER]: assertion }), {})),
    ).toBe(401);
  });

  it("accepts the self-hosted clock's token", async () => {
    const token = await mintTickToken(SECRET);
    expect(
      await status(authorizeSchedulerTick(tickRequest({ authorization: `Bearer ${token}` }), {})),
    ).toBe("internal-token");
  });

  it("refuses an internal token of another scope, and no credential at all", async () => {
    const now = Date.now();
    const other = await signInternalToken({
      iat: now,
      exp: now + 60_000,
      scope: "auth.owner_reset",
    });
    expect(
      await status(authorizeSchedulerTick(tickRequest({ authorization: `Bearer ${other}` }), {})),
    ).toBe(401);
    expect(await status(authorizeSchedulerTick(tickRequest({}), env))).toBe(401);
  });
});
