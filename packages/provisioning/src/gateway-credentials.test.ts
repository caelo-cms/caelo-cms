// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  ensureGatewayRolePassword,
  findSqlInstance,
  gatewayMovesPublicRole,
  planPublicRoleSwitch,
} from "./gateway-credentials.js";
import type { GcloudResult } from "./gcloud.js";
import type { HttpFetch } from "./runtime-secrets.js";
import type { LiveEnvValue } from "./stack-converge.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** Fake gcloud: secret values by secret id, a token, everything else ok. */
function fakeGcloud(secrets: Record<string, string>) {
  const lines: string[] = [];
  const run = async (args: string[]) => {
    const line = args.join(" ");
    lines.push(line);
    if (line.startsWith("auth print-access-token")) return ok("tok\n");
    const secret = /--secret=caelo-production-([a-z-]+)/.exec(line)?.[1];
    if (line.startsWith("secrets versions access") && secret) {
      const value = secrets[secret];
      return value === undefined ? fail(`NOT_FOUND: ${secret}`) : ok(value);
    }
    if (line.startsWith("sql instances list")) return ok("caelo-production-pg-1a2b3c\n");
    return ok();
  };
  return { run, lines };
}

/** Fake Cloud SQL Admin API recording `role password` per user update. */
function fakeSqlApi(failRoles: string[] = []) {
  const set: string[] = [];
  const http: HttpFetch = async (url, init) => {
    const role = new URL(url).searchParams.get("name") ?? "?";
    if (init.method === "PUT") {
      if (failRoles.includes(role)) {
        return { ok: false, status: 403, text: async () => "PERMISSION_DENIED" };
      }
      set.push(`${role} ${(JSON.parse(init.body ?? "{}") as { password: string }).password}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "DONE" }) };
  };
  return { http, set };
}

const target = { projectId: "acme", env: "production", sqlInstance: "caelo-production-pg-1" };
const SECRETS = {
  "postgres-password": "admin-pw",
  "public-role-password": "public-pw",
  "gateway-role-password": "gateway-pw",
};
const secretRef = (secret: string): LiveEnvValue => ({
  kind: "secret",
  secret: `caelo-production-${secret}`,
  version: "latest",
});
/** The gateway as #579 left it: public_role on admin_role's password. */
const BEFORE_613 = new Map<string, LiveEnvValue>([
  ["PUBLIC_DATABASE_PASSWORD", secretRef("postgres-password")],
  ["ADMIN_DATABASE_PASSWORD", secretRef("postgres-password")],
]);
const AFTER_613 = new Map<string, LiveEnvValue>([
  ["PUBLIC_DATABASE_PASSWORD", secretRef("public-role-password")],
  ["GATEWAY_DATABASE_PASSWORD", secretRef("gateway-role-password")],
]);

describe("gatewayMovesPublicRole", () => {
  it("is true until the gateway reads public_role's own secret", () => {
    expect(gatewayMovesPublicRole(BEFORE_613, "production")).toBe(true);
    // v0.10.29: the password inline in a plain URL.
    expect(
      gatewayMovesPublicRole(
        new Map([
          ["PUBLIC_DATABASE_URL", { kind: "value", value: "postgres://public_role:x@h/db" }],
        ]),
        "production",
      ),
    ).toBe(true);
    expect(gatewayMovesPublicRole(AFTER_613, "production")).toBe(false);
  });
});

describe("ensureGatewayRolePassword", () => {
  it("sets gateway_role from its secret through the API, never on argv", async () => {
    const { run, lines } = fakeGcloud(SECRETS);
    const sql = fakeSqlApi();
    const r = await ensureGatewayRolePassword(target, {
      run,
      http: sql.http,
      sleep: async () => {},
    });
    expect(r.status).toBe("applied");
    expect(sql.set).toEqual(["gateway_role gateway-pw"]);
    expect(lines.some((l) => l.includes("gateway-pw"))).toBe(false);
  });

  it("fails, naming the secret, when the secret can't be read", async () => {
    const { run } = fakeGcloud({});
    const r = await ensureGatewayRolePassword(target, {
      run,
      http: fakeSqlApi().http,
      sleep: async () => {},
    });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("caelo-production-gateway-role-password");
  });
});

describe("planPublicRoleSwitch", () => {
  it("first upgrade: moves public_role onto its own password before the gateway rolls", async () => {
    const { run } = fakeGcloud(SECRETS);
    const sql = fakeSqlApi();
    const sw = planPublicRoleSwitch(target, BEFORE_613, {
      run,
      http: sql.http,
      sleep: async () => {},
    });
    expect(sw.moves).toBe(true);
    expect((await sw.beforeGatewayRoll()).status).toBe("applied");
    expect(sql.set).toEqual(["public_role public-pw"]);
  });

  it("a failed gateway roll puts public_role back on the password the old revision reads", async () => {
    const { run } = fakeGcloud(SECRETS);
    const sql = fakeSqlApi();
    const sw = planPublicRoleSwitch(target, BEFORE_613, {
      run,
      http: sql.http,
      sleep: async () => {},
    });
    await sw.beforeGatewayRoll();
    expect(await sw.afterGatewayRollFailed()).toContain("set back");
    expect(sql.set).toEqual(["public_role public-pw", "public_role admin-pw"]);
  });

  it("later upgrades re-apply the same value and have nothing to undo", async () => {
    const { run } = fakeGcloud(SECRETS);
    const sql = fakeSqlApi();
    const sw = planPublicRoleSwitch(target, AFTER_613, {
      run,
      http: sql.http,
      sleep: async () => {},
    });
    expect(sw.moves).toBe(false);
    await sw.beforeGatewayRoll();
    expect(await sw.afterGatewayRollFailed()).toBe("public_role was not changed");
    expect(sql.set).toEqual(["public_role public-pw"]);
  });

  it("says so loudly when public_role can't be set back", async () => {
    const { run } = fakeGcloud(SECRETS);
    let calls = 0;
    const http: HttpFetch = async (_url, init) => {
      if (init.method === "PUT" && ++calls === 2) {
        return { ok: false, status: 403, text: async () => "PERMISSION_DENIED" };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "DONE" }) };
    };
    const sw = planPublicRoleSwitch(target, BEFORE_613, { run, http, sleep: async () => {} });
    await sw.beforeGatewayRoll();
    expect(await sw.afterGatewayRollFailed()).toMatch(/could NOT set public_role back.*by hand/);
  });
});

describe("findSqlInstance", () => {
  it("finds the Pulumi-suffixed instance by the stack's prefix", async () => {
    const { run, lines } = fakeGcloud({});
    expect(await findSqlInstance({ projectId: "acme", env: "production" }, { run })).toBe(
      "caelo-production-pg-1a2b3c",
    );
    expect(lines).toContain(
      "sql instances list --project=acme --filter=name~^caelo-production-pg --format=value(name)",
    );
  });
});
