// SPDX-License-Identifier: MPL-2.0

/**
 * #678 — behind Google IAP the request's `Authorization` carries the IAP
 * credential, so /api/internal/* also accepts the internal token in
 * `x-caelo-internal-token`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { INTERNAL_TOKEN_HEADER, requireInternalAuth, signInternalToken } from "./internal-jwt.js";

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

describe("requireInternalAuth", () => {
  it("accepts the token in its own header while Authorization carries the IAP JWT", async () => {
    const req = new Request("https://admin.test/api/internal/staging/provision", {
      method: "POST",
      headers: {
        authorization: "Bearer iap.jwt.from-google",
        [INTERNAL_TOKEN_HEADER]: await token("staging.provision"),
      },
    });
    const payload = await requireInternalAuth(req, "staging.provision");
    expect(payload.scope).toBe("staging.provision");
  });

  it("still accepts a bearer token, and rejects a token for another scope", async () => {
    const bearer = new Request("https://admin.test/x", {
      headers: { authorization: `Bearer ${await token("provisioning-outputs.sync")}` },
    });
    expect((await requireInternalAuth(bearer, "provisioning-outputs.sync")).scope).toBe(
      "provisioning-outputs.sync",
    );
    const wrong = new Request("https://admin.test/x", {
      headers: { [INTERNAL_TOKEN_HEADER]: await token("provisioning-outputs.sync") },
    });
    let thrown: unknown = null;
    try {
      await requireInternalAuth(wrong, "staging.provision");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });
});
