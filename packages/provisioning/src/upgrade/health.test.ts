// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "../gcloud.js";
import type { HttpFetch } from "../runtime-secrets.js";
import {
  createIapHealthProbe,
  evaluateAdminDeepHealth,
  evaluateGatewayDeepHealth,
  type HealthTarget,
  healthOrigins,
} from "./health.js";

const migrations = (adminPending = 0, publicPending = 0) => ({
  admin: { head: "0262_tool_approval_branch.sql", pending: adminPending },
  public: { head: "0040_x.sql", pending: publicPending },
});
const adminBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, version: "0.11.0", migrations: migrations(), ...over });

describe("evaluateAdminDeepHealth", () => {
  it("accepts a healthy admin on the targeted version with every migration applied", () => {
    const r = evaluateAdminDeepHealth(200, adminBody(), "0.11.0");
    expect(r).toEqual({
      ok: true,
      version: "0.11.0",
      detail: "admin 0.11.0, migrations at 0262_tool_approval_branch.sql / 0040_x.sql",
    });
  });

  it("names the database that misses migrations", () => {
    const r = evaluateAdminDeepHealth(
      503,
      adminBody({ ok: false, migrations: migrations(0, 2) }),
      null,
    );
    expect(r).toEqual({
      ok: false,
      error:
        "cms_public is missing 2 migration(s) the new admin image ships (applied head: 0040_x.sql)",
    });
  });

  it("refuses a different version than the one rolled", () => {
    const r = evaluateAdminDeepHealth(200, adminBody({ version: "0.10.43" }), "0.11.0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("admin runs 0.10.43, the roll targeted 0.11.0");
  });

  it("refuses an image without the deep check and points at --skip-health-check", () => {
    const r = evaluateAdminDeepHealth(200, JSON.stringify({ ok: true, version: "0.11.0" }), null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--skip-health-check");
  });

  it("reports an unreachable database", () => {
    const r = evaluateAdminDeepHealth(
      503,
      JSON.stringify({
        ok: false,
        version: "0.11.0",
        error: { kind: "DbUnreachable", message: "m" },
      }),
      null,
    );
    expect(r).toEqual({ ok: false, error: "admin reports unhealthy (HTTP 503, DbUnreachable: m)" });
  });

  it("treats an HTML page (IAP login) as a failure", () => {
    expect(evaluateAdminDeepHealth(200, "<html>Sign in</html>", null).ok).toBe(false);
  });
});

describe("evaluateGatewayDeepHealth", () => {
  it("accepts a healthy gateway on the admin's version", () => {
    expect(
      evaluateGatewayDeepHealth(200, JSON.stringify({ ok: true, version: "0.11.0" }), "0.11.0"),
    ).toEqual({ ok: true, detail: "gateway 0.11.0" });
  });

  it("refuses a gateway on another version than the admin", () => {
    const r = evaluateGatewayDeepHealth(
      200,
      JSON.stringify({ ok: true, version: "0.10.0" }),
      "0.11.0",
    );
    expect(r.ok).toBe(false);
  });

  it("refuses a gateway that can't reach its database", () => {
    const r = evaluateGatewayDeepHealth(
      503,
      JSON.stringify({ ok: false, version: "0.11.0", error: { kind: "DbUnreachable" } }),
      "0.11.0",
    );
    expect(r).toEqual({ ok: false, error: "gateway reports unhealthy (HTTP 503, DbUnreachable)" });
  });
});

const FIREBASE: HealthTarget = {
  provider: "gcp-firebase",
  projectId: "acme",
  domain: "acme.com",
  adminServiceUrl: "https://caelo-production-admin-aaa-xyz.a.run.app",
  gatewayServiceUrl: "https://caelo-production-gateway-bbb-xyz.a.run.app",
};

describe("healthOrigins", () => {
  it("uses the load balancer hosts on gcp", () => {
    expect(healthOrigins({ ...FIREBASE, provider: "gcp" })).toEqual({
      admin: "https://admin.acme.com",
      gateway: "https://acme.com",
    });
  });

  it("uses the run.app URLs on gcp-firebase", () => {
    expect(healthOrigins(FIREBASE)).toEqual({
      admin: "https://caelo-production-admin-aaa-xyz.a.run.app",
      gateway: "https://caelo-production-gateway-bbb-xyz.a.run.app",
    });
  });
});

describe("createIapHealthProbe", () => {
  const gcloudOk = async (): Promise<GcloudResult> => ({
    ok: true,
    stdout: "ya29.token\n",
    stderr: "",
    exitCode: 0,
  });

  /** A fake network: signJwt + the two health endpoints. */
  function network(answers: { admin: () => [number, string]; gateway: () => [number, string] }) {
    const requests: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const http: HttpFetch = async (url, init) => {
      requests.push({ url, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
      const [status, text] = url.includes(":signJwt")
        ? [200, JSON.stringify({ signedJwt: "signed.jwt" })]
        : url.includes("admin")
          ? answers.admin()
          : answers.gateway();
      return { ok: status < 400, status, text: async () => text };
    };
    return { http, requests };
  }

  it("signs an IAP credential for the admin origin and sends it to the admin only", async () => {
    const net = network({
      admin: () => [200, adminBody()],
      gateway: () => [200, JSON.stringify({ ok: true, version: "0.11.0" })],
    });
    const probe = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http: net.http,
      sleep: async () => {},
      now: () => 1000,
    });
    expect(await probe.deep({ version: "0.11.0" })).toEqual({
      ok: true,
      detail:
        "admin 0.11.0, migrations at 0262_tool_approval_branch.sql / 0040_x.sql; gateway 0.11.0",
    });
    const sign = net.requests[0];
    expect(sign?.url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/caelo-mcp%40acme.iam.gserviceaccount.com:signJwt",
    );
    const claims = JSON.parse((JSON.parse(sign?.body ?? "{}") as { payload: string }).payload);
    expect(claims).toEqual({
      iss: "caelo-mcp@acme.iam.gserviceaccount.com",
      sub: "caelo-mcp@acme.iam.gserviceaccount.com",
      aud: "https://caelo-production-admin-aaa-xyz.a.run.app/*",
      iat: 1000,
      exp: 1600,
    });
    const admin = net.requests.find(
      (r) => r.url.endsWith("/_caelo/health?deep=1") && r.url.includes("admin"),
    );
    expect(admin?.headers.Authorization).toBe("Bearer signed.jwt");
    const gateway = net.requests.find((r) => r.url.endsWith("/api/_caelo/health?deep=1"));
    expect(gateway?.url).toBe(
      "https://caelo-production-gateway-bbb-xyz.a.run.app/api/_caelo/health?deep=1",
    );
    expect(gateway?.headers.Authorization).toBeUndefined();
  });

  it("retries while the new revisions warm up, then gives the last error", async () => {
    let calls = 0;
    const net = network({
      admin: () => {
        calls++;
        return calls < 3
          ? [503, adminBody({ ok: false, migrations: migrations(1) })]
          : [200, adminBody()];
      },
      gateway: () => [200, JSON.stringify({ ok: true, version: "0.11.0" })],
    });
    const probe = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http: net.http,
      sleep: async () => {},
      attempts: 5,
    });
    expect((await probe.deep({ version: null })).ok).toBe(true);
    expect(calls).toBe(3);

    const stuck = network({
      admin: () => [503, adminBody({ ok: false, migrations: migrations(1) })],
      gateway: () => [200, "{}"],
    });
    const failing = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http: stuck.http,
      sleep: async () => {},
      attempts: 2,
    });
    const r = await failing.deep({ version: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cms_admin is missing 1 migration(s)");
  });

  it("baseline fails when IAP answers instead of the admin", async () => {
    const net = network({
      admin: () => [200, "<html>Sign in with Google</html>"],
      gateway: () => [404, "{}"],
    });
    const probe = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http: net.http,
      sleep: async () => {},
    });
    const r = await probe.baseline();
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toContain("IAP may not admit caelo-mcp@acme.iam.gserviceaccount.com");
  });

  it("baseline succeeds when the old admin answers its shallow check and the gateway answers at all", async () => {
    const net = network({
      admin: () => [200, JSON.stringify({ ok: true, version: "0.10.43" })],
      gateway: () => [404, '{"ok":false}'],
    });
    const probe = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http: net.http,
      sleep: async () => {},
    });
    expect(await probe.baseline()).toEqual({
      ok: true,
      detail: "admin 0.10.43 and gateway reachable",
    });
  });

  it("baseline fails with the cause when the operator can't sign as the MCP account", async () => {
    const http: HttpFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => "Permission iam.serviceAccounts.signJwt denied",
    });
    const probe = createIapHealthProbe(FIREBASE, { run: gcloudOk, http, sleep: async () => {} });
    const r = await probe.baseline();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("roles/iam.serviceAccountTokenCreator");
  });
});
