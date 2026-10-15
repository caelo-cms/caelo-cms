// SPDX-License-Identifier: MPL-2.0

/**
 * #769 — the HTTP boundary of POST /api/internal/owner-reset, which hands a
 * raw reset credential back to its caller: it must refuse before reading the
 * body unless the internal token is valid for exactly `auth.owner_reset`, and
 * refuse a body that is not the CLI's `{ email?, requestedBy }`. None of these
 * paths reach the database.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { POST } from "../../routes/api/internal/owner-reset/+server.js";
import { INTERNAL_TOKEN_HEADER, signInternalToken } from "./internal-jwt.js";

const SECRET_ENV = "CAELO_INTERNAL_SECRET";
let savedSecret: string | undefined;

beforeAll(() => {
  savedSecret = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = "owner-reset-route-test-secret-0123456789abcdef";
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
  const request = new Request("http://admin.test/api/internal/owner-reset", {
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

describe("POST /api/internal/owner-reset", () => {
  const validBody = JSON.stringify({ requestedBy: "operator@example.com" });

  it("answers 401 without an internal token", async () => {
    const res = await post({}, validBody);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "missing-bearer" });
  });

  it("answers 401 for a token signed for another endpoint's scope", async () => {
    const res = await post(
      { [INTERNAL_TOKEN_HEADER]: await tokenFor("staging.provision") },
      validBody,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "scope-mismatch" });
  });

  it("answers 401 for a token signed with another secret", async () => {
    const token = await tokenFor("auth.owner_reset");
    process.env[SECRET_ENV] = "a-different-secret-for-this-one-check-0123456789";
    try {
      const res = await post({ [INTERNAL_TOKEN_HEADER]: token }, validBody);
      expect(res.status).toBe(401);
    } finally {
      process.env[SECRET_ENV] = "owner-reset-route-test-secret-0123456789abcdef";
    }
  });

  it("answers 400 for a body that is not the CLI's request", async () => {
    const auth = { [INTERNAL_TOKEN_HEADER]: await tokenFor("auth.owner_reset") };
    const bad = [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ email: "owner@example.com" }),
      JSON.stringify({ requestedBy: "operator@example.com", email: "not-an-email" }),
      JSON.stringify({ requestedBy: "operator@example.com", extra: true }),
      JSON.stringify({ requestedBy: "op\nerator@example.com" }),
      JSON.stringify({ requestedBy: "<script>@example.com" }),
      JSON.stringify({ requestedBy: `${"a".repeat(250)}@example.com` }),
    ];
    for (const body of bad) {
      const res = await post(auth, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    }
  });
});
