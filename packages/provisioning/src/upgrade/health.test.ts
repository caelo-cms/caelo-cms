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
  IAM_PROPAGATION_WINDOW_MS,
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
      accessJustChanged: false,
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
      accessJustChanged: false,
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
      accessJustChanged: false,
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
      accessJustChanged: false,
    });
    const r = await probe.baseline();
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toContain("IAP may not admit caelo-mcp@acme.iam.gserviceaccount.com");
  });

  it("#733 — baseline succeeds when the old admin answers its shallow check and an old gateway its own JSON 404", async () => {
    const net = network({
      admin: () => [200, JSON.stringify({ ok: true, version: "0.10.43" })],
      gateway: () => [404, '{"ok":false}'],
    });
    const probe = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http: net.http,
      sleep: async () => {},
      accessJustChanged: false,
    });
    expect(await probe.baseline()).toEqual({
      ok: true,
      detail: "admin 0.10.43 and gateway reachable",
    });
  });

  it("#733 — baseline fails when the gateway answers Google's HTML 404, naming the ingress", async () => {
    const net = network({
      admin: () => [200, JSON.stringify({ ok: true, version: "0.10.20" })],
      gateway: () => [404, "<!DOCTYPE html><html><title>Error 404 (Not Found)!!1</title>"],
    });
    const probe = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http: net.http,
      sleep: async () => {},
      accessJustChanged: false,
    });
    const r = await probe.baseline();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("answered HTTP 404 without JSON");
      expect(r.error).toContain('ingress "all"');
    }
    const lb = createIapHealthProbe(
      { ...FIREBASE, provider: "gcp" },
      { run: gcloudOk, http: net.http, sleep: async () => {}, accessJustChanged: false },
    );
    const viaLb = await lb.baseline();
    if (!viaLb.ok) expect(viaLb.error).toContain("route /api/* to the gateway backend");
    expect(viaLb.ok).toBe(false);
  });

  describe("#734 — a refused signJwt right after converge granted it", () => {
    /** signJwt answers 403 `denials` times, then signs. */
    function propagating(denials: number) {
      let signs = 0;
      const http: HttpFetch = async (url) => {
        if (url.includes(":signJwt")) {
          signs++;
          return signs <= denials
            ? {
                ok: false,
                status: 403,
                text: async () => "Permission 'iam.serviceAccounts.signJwt' denied",
              }
            : { ok: true, status: 200, text: async () => JSON.stringify({ signedJwt: "s.j" }) };
        }
        return url.includes("admin")
          ? { ok: true, status: 200, text: async () => JSON.stringify({ version: "0.10.20" }) }
          : { ok: false, status: 404, text: async () => '{"ok":false}' };
      };
      return { http, signs: () => signs };
    }

    it("waits for the grant to apply, saying why, then passes", async () => {
      const net = propagating(4);
      const slept: number[] = [];
      const waits: string[] = [];
      const probe = createIapHealthProbe(FIREBASE, {
        run: gcloudOk,
        http: net.http,
        sleep: async (ms) => {
          slept.push(ms);
        },
        accessJustChanged: true,
      });
      expect(await probe.baseline((reason) => waits.push(reason))).toEqual({
        ok: true,
        detail: "admin 0.10.20 and gateway reachable",
      });
      expect(net.signs()).toBe(5);
      expect(slept).toEqual([5_000, 10_000, 20_000, 30_000]);
      expect(waits).toHaveLength(4);
      expect(waits[0]).toContain("Waiting for the access the converge step just granted");
    });

    it("gives up after the propagation window: the grant exists, re-run in a few minutes", async () => {
      const net = propagating(Number.POSITIVE_INFINITY);
      let slept = 0;
      const probe = createIapHealthProbe(FIREBASE, {
        run: gcloudOk,
        http: net.http,
        sleep: async (ms) => {
          slept += ms;
        },
        accessJustChanged: true,
      });
      const r = await probe.baseline();
      expect(slept).toBe(IAM_PROPAGATION_WINDOW_MS);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("The grant exists; nothing was changed: re-run upgrade");
        expect(r.error).toContain("after 7 minutes");
      }
    });

    it("fails at once when nothing was just granted: the grant is missing", async () => {
      const net = propagating(Number.POSITIVE_INFINITY);
      let slept = 0;
      const probe = createIapHealthProbe(FIREBASE, {
        run: gcloudOk,
        http: net.http,
        sleep: async (ms) => {
          slept += ms;
        },
        accessJustChanged: false,
      });
      const r = await probe.baseline();
      expect(slept).toBe(0);
      expect(net.signs()).toBe(1);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("it lacks roles/iam.serviceAccountTokenCreator");
        expect(r.error).toContain("run upgrade as an allowlisted account");
      }
    });

    it("never waits out a failure that is not a refusal", async () => {
      const http: HttpFetch = async () => {
        throw new Error("ENOTFOUND");
      };
      let slept = 0;
      const probe = createIapHealthProbe(FIREBASE, {
        run: gcloudOk,
        http,
        sleep: async (ms) => {
          slept += ms;
        },
        accessJustChanged: true,
      });
      expect((await probe.baseline()).ok).toBe(false);
      expect(slept).toBe(0);
    });
  });

  it("a transport failure while signing is a failed check, not a throw", async () => {
    const http: HttpFetch = async () => {
      throw new Error("ECONNRESET");
    };
    const probe = createIapHealthProbe(FIREBASE, {
      run: gcloudOk,
      http,
      sleep: async () => {},
      accessJustChanged: false,
      attempts: 2,
    });
    const r = await probe.deep({ version: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ECONNRESET");
  });
});
