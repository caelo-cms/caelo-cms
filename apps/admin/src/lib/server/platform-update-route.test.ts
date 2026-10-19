// SPDX-License-Identifier: MPL-2.0

/**
 * #818 — the HTTP boundary of POST /api/internal/platform-update, which
 * queues a Caelo release and starts the upgrader: it must refuse before
 * reading the body unless the internal token is valid for exactly
 * `platform_updates.operator`, and refuse any body that is not one of the
 * CLI's two shapes. None of these paths reach the database; the op behind
 * it is covered against real Postgres in admin-core's
 * platform-update-install integration test.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { POST } from "../../routes/api/internal/platform-update/+server.js";
import { INTERNAL_TOKEN_HEADER, signInternalToken } from "./internal-jwt.js";

const SECRET_ENV = "CAELO_INTERNAL_SECRET";
const SECRET = "platform-update-route-test-secret-0123456789abcdef";
let savedSecret: string | undefined;

beforeAll(() => {
  savedSecret = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = SECRET;
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = savedSecret;
});

async function tokenFor(scope: string): Promise<string> {
  const iat = Date.now();
  return signInternalToken({ iat, exp: iat + 60_000, scope });
}

/** Call the handler the way SvelteKit does; a thrown Response is the answer. */
async function post(headers: Record<string, string>, body: string): Promise<Response> {
  const request = new Request("http://admin.test/api/internal/platform-update", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  try {
    return await POST({ request } as unknown as Parameters<typeof POST>[0]);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

describe("POST /api/internal/platform-update", () => {
  const validBody = JSON.stringify({
    action: "request",
    version: "0.11.0-rc.1",
    requestedBy: "smoke@caelo-smoke.iam.gserviceaccount.com",
  });

  it("answers 401 without an internal token", async () => {
    const res = await post({}, validBody);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "missing-bearer" });
  });

  it("answers 401 for a token signed for another endpoint's scope (owner-reset's included)", async () => {
    for (const scope of ["auth.owner_reset", "staging.provision"]) {
      const res = await post({ [INTERNAL_TOKEN_HEADER]: await tokenFor(scope) }, validBody);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "scope-mismatch" });
    }
  });

  it("answers 401 for a token signed with another secret", async () => {
    const token = await tokenFor("platform_updates.operator");
    process.env[SECRET_ENV] = "a-different-secret-for-this-one-check-0123456789";
    try {
      const res = await post({ [INTERNAL_TOKEN_HEADER]: token }, validBody);
      expect(res.status).toBe(401);
    } finally {
      process.env[SECRET_ENV] = SECRET;
    }
  });

  it("answers 400 for a body that is not one of the CLI's requests", async () => {
    const auth = { [INTERNAL_TOKEN_HEADER]: await tokenFor("platform_updates.operator") };
    const by = "operator@example.com";
    const bad = [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ action: "install", version: "0.11.0", requestedBy: by }),
      JSON.stringify({ action: "request", version: "v0.11.0", requestedBy: by }),
      JSON.stringify({ action: "request", version: "latest", requestedBy: by }),
      JSON.stringify({ action: "request", version: "0.11.0" }),
      JSON.stringify({ action: "request", version: "0.11.0", requestedBy: "op\nerator@x.com" }),
      JSON.stringify({ action: "request", version: "0.11.0", requestedBy: by, image: "evil" }),
      JSON.stringify({ action: "status", requestId: "not-a-uuid" }),
      JSON.stringify({
        action: "status",
        requestId: "00000000-0000-0000-0000-000000000001",
        extra: 1,
      }),
    ];
    for (const b of bad) {
      const res = await post(auth, b);
      expect({ body: b, status: res.status }).toEqual({ body: b, status: 400 });
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    }
  });
});
