// SPDX-License-Identifier: MPL-2.0

/**
 * #678 — behind Google IAP the request's `Authorization` carries the IAP
 * credential, so /api/internal/* also accepts the internal token in
 * `x-caelo-internal-token`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { INTERNAL_TOKEN_HEADER, internalAuthRefusal, signInternalToken } from "./internal-jwt.js";

const saved = process.env.CAELO_INTERNAL_SECRET;
beforeAll(() => {
  process.env.CAELO_INTERNAL_SECRET = "i".repeat(40);
});
afterAll(() => {
  if (saved === undefined) delete process.env.CAELO_INTERNAL_SECRET;
  else process.env.CAELO_INTERNAL_SECRET = saved;
});

async function token(scope: string): Promise<string> {
  const now = Date.now();
  return signInternalToken({ iat: now, exp: now + 60_000, scope });
}

describe("internalAuthRefusal", () => {
  it("accepts the token in its own header while Authorization carries the IAP JWT", async () => {
    const req = new Request("https://admin.test/api/internal/staging/provision", {
      method: "POST",
      headers: {
        authorization: "Bearer iap.jwt.from-google",
        [INTERNAL_TOKEN_HEADER]: await token("staging.provision"),
      },
    });
    expect(await internalAuthRefusal(req, "staging.provision")).toBeNull();
  });

  it("still accepts a bearer token", async () => {
    const bearer = new Request("https://admin.test/x", {
      headers: { authorization: `Bearer ${await token("provisioning-outputs.sync")}` },
    });
    expect(await internalAuthRefusal(bearer, "provisioning-outputs.sync")).toBeNull();
  });

  // #1563 — returned, never thrown: SvelteKit answers a thrown Response with a 500.
  it("returns a 401 naming the reason for a token of another scope", async () => {
    const wrong = new Request("https://admin.test/x", {
      headers: { [INTERNAL_TOKEN_HEADER]: await token("provisioning-outputs.sync") },
    });
    const refusal = await internalAuthRefusal(wrong, "staging.provision");
    expect(refusal?.status).toBe(401);
    expect(refusal?.headers.get("content-type")).toBe("application/json");
    expect(await refusal?.json()).toEqual({ ok: false, error: "scope-mismatch" });
  });

  it("returns a 401 for a request without a token", async () => {
    const none = new Request("https://admin.test/x", { method: "POST" });
    const refusal = await internalAuthRefusal(none, "staging.provision");
    expect(refusal?.status).toBe(401);
    expect(await refusal?.json()).toEqual({ ok: false, error: "missing-bearer" });
  });
});
