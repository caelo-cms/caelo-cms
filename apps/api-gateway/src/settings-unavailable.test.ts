// SPDX-License-Identifier: MPL-2.0

/**
 * #613 review — a settings load that fails must not hand an unauthenticated
 * caller the raw database error (hosts, role names, SQL). Since #1326 the
 * caller gets `{ kind, requestId }` only, the gateway's own readiness
 * reason included; both are logged under the request id.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { handleRequest, invalidateGatewaySettings, setGatewayAdapter } from "./server.js";

/** An adapter whose every cms_public query returns `rows`, or whose transactions throw `error`. */
function fakeAdapter(outcome: { rows: unknown[] } | { error: Error }): DatabaseAdapter {
  return {
    withPublicTransaction: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      if ("error" in outcome) throw outcome.error;
      return fn({ execute: async () => outcome.rows });
    },
  } as unknown as DatabaseAdapter;
}

const challenge = () =>
  handleRequest(new Request("http://localhost/api/captcha/challenge"), {
    peerAddress: "198.51.100.7",
  });

const priorHops = process.env.CAELO_TRUSTED_PROXY_HOPS;
beforeAll(() => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "0";
});
afterAll(() => {
  if (priorHops === undefined) delete process.env.CAELO_TRUSTED_PROXY_HOPS;
  else process.env.CAELO_TRUSTED_PROXY_HOPS = priorHops;
});

afterEach(() => {
  invalidateGatewaySettings();
});

describe("settings that cannot be loaded (#613 review)", () => {
  it("hides a database failure from the caller and logs it with credentials masked", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failure = Object.assign(
        new Error(
          'connect to postgres://gateway_role:hunter2@10.20.0.3:5432/cms_admin failed: relation "site_settings" does not exist',
        ),
        { code: "42P01" },
      );
      setGatewayAdapter(fakeAdapter({ error: failure }));
      invalidateGatewaySettings();
      const r = await challenge();
      expect(r.status).toBe(503);
      const text = await r.text();
      const body = JSON.parse(text) as { error: { kind: string; requestId: string } };
      expect(body.error.kind).toBe("ServiceUnavailable");
      expect(Object.keys(body.error).sort()).toEqual(["kind", "requestId"]);
      for (const leak of ["10.20.0.3", "gateway_role", "site_settings", "hunter2"]) {
        expect(text).not.toContain(leak);
      }
      const line = logged.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toContain(`request ${body.error.requestId}: ServiceUnavailable`);
      expect(line).toContain("(42P01)");
      expect(line).toContain("postgres://***@10.20.0.3");
      expect(line).not.toContain("hunter2");
    } finally {
      logged.mockRestore();
    }
  });

  it("logs the gateway's own readiness reason and answers only its kind", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setGatewayAdapter(fakeAdapter({ rows: [] }));
      invalidateGatewaySettings();
      const r = await challenge();
      expect(r.status).toBe(503);
      const text = await r.text();
      expect(text).not.toContain("migrations");
      const line = logged.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toContain(
        "the admin has not published the gateway settings yet; run the database migrations",
      );
    } finally {
      logged.mockRestore();
    }
  });
});
