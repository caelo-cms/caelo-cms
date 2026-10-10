// SPDX-License-Identifier: MPL-2.0

/**
 * #613 review — a settings load that fails must not hand an unauthenticated
 * caller the raw database error (hosts, role names, SQL). Only the gateway's
 * own readiness reason is shown; anything else is logged and answered with
 * a generic 503.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { handleRequest, invalidateGatewaySettings, setGatewayAdapter } from "./server.js";

/** An adapter whose every cms_admin transaction resolves to `rows` or throws `error`. */
function fakeAdapter(outcome: { rows: unknown[] } | { error: Error }): DatabaseAdapter {
  return {
    withAdminTransaction: async () => {
      if ("error" in outcome) throw outcome.error;
      return outcome.rows;
    },
  } as unknown as DatabaseAdapter;
}

const challenge = () => handleRequest(new Request("http://localhost/api/captcha/challenge"));

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
      expect(text).toContain("temporarily unavailable");
      for (const leak of ["10.20.0.3", "gateway_role", "site_settings", "hunter2"]) {
        expect(text).not.toContain(leak);
      }
      const line = logged.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toContain("(42P01)");
      expect(line).toContain("postgres://***@10.20.0.3");
      expect(line).not.toContain("hunter2");
    } finally {
      logged.mockRestore();
    }
  });

  it("shows the gateway's own readiness reason", async () => {
    setGatewayAdapter(fakeAdapter({ rows: [] }));
    invalidateGatewaySettings();
    const r = await challenge();
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("site_settings has no row; run the database migrations");
  });
});
