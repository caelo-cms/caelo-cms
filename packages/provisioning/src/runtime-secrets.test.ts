// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { migrationJobEnvArgs, parseAdminConfig } from "./migration-runner.js";
import {
  ensureGatewayServiceAccount,
  ensureGeneratedSecrets,
  type HttpFetch,
  plainGeneratedSecretSeed,
  readSecretReplication,
  rotateRuntimeSecret,
  rotationRefusal,
  stackSecretReplication,
} from "./runtime-secrets.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

interface Call {
  readonly line: string;
  readonly stdin?: string;
}

/** Fake gcloud answering by longest command prefix; records argv + stdin. */
function fakeGcloud(answers: Record<string, GcloudResult[]>, fallback: GcloudResult = ok()) {
  const calls: Call[] = [];
  const run = async (args: string[], opts?: { stdin?: string }) => {
    const line = args.join(" ");
    calls.push(opts?.stdin === undefined ? { line } : { line, stdin: opts.stdin });
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const queue = key ? answers[key] : undefined;
    if (!queue || queue.length === 0) return fallback;
    return queue.length > 1 ? (queue.shift() as GcloudResult) : (queue[0] as GcloudResult);
  };
  return { run, calls, lines: () => calls.map((c) => c.line) };
}

const install = { projectId: "acme", env: "production" };
const NOT_FOUND = fail("ERROR: NOT_FOUND: Secret [x] not found or has no versions.");

describe("ensureGatewayServiceAccount", () => {
  it("leaves an existing SA alone", async () => {
    const { run, lines } = fakeGcloud({ "iam service-accounts describe": [ok("gw@")] });
    expect((await ensureGatewayServiceAccount(install, { run })).status).toBe("present");
    expect(lines().some((l) => l.includes(" create "))).toBe(false);
  });

  it("creates a missing SA with the stack's account id", async () => {
    const { run, lines } = fakeGcloud({
      "iam service-accounts describe": [fail("ERROR: NOT_FOUND: Unknown service account")],
    });
    expect((await ensureGatewayServiceAccount(install, { run })).status).toBe("applied");
    expect(lines()).toContain(
      "iam service-accounts create caelo-production-gateway-sa --project=acme --display-name=Caelo production gateway --quiet",
    );
  });

  it("fails (does not create) when the SA can't be read for another reason", async () => {
    const { run, lines } = fakeGcloud({
      "iam service-accounts describe": [fail("PERMISSION_DENIED: iam.serviceAccounts.get")],
    });
    const outcome = await ensureGatewayServiceAccount(install, { run });
    expect(outcome.status).toBe("failed");
    expect(lines().some((l) => l.includes(" create "))).toBe(false);
  });
});

describe("readSecretReplication / stackSecretReplication", () => {
  it("mirrors the postgres-password secret's replication", async () => {
    const regional = fakeGcloud({
      "secrets describe caelo-production-postgres-password": [
        ok(
          JSON.stringify({
            replication: { userManaged: { replicas: [{ location: "europe-west1" }] } },
          }),
        ),
      ],
    });
    expect(await readSecretReplication(install, { run: regional.run })).toEqual({
      ok: true,
      replication: { kind: "user-managed", locations: ["europe-west1"] },
    });
    const auto = fakeGcloud({
      "secrets describe": [ok(JSON.stringify({ replication: { automatic: {} } }))],
    });
    expect(await readSecretReplication(install, { run: auto.run })).toEqual({
      ok: true,
      replication: { kind: "automatic" },
    });
  });

  it("maps the stack's secretReplication config", () => {
    expect(stackSecretReplication("auto", "r")).toEqual({ kind: "automatic" });
    expect(stackSecretReplication("regional", "r")).toEqual({
      kind: "user-managed",
      locations: ["r"],
    });
  });
});

describe("ensureGeneratedSecrets", () => {
  const regional = { kind: "user-managed" as const, locations: ["europe-west1"] };

  it("is a read-only no-op when every secret has an enabled version", async () => {
    const { run, lines } = fakeGcloud({
      "secrets describe": [ok("projects/1/secrets/x")],
      "secrets versions list": [ok("projects/1/secrets/x/versions/1")],
    });
    const outcomes = await ensureGeneratedSecrets({ ...install, replication: regional }, { run });
    expect(outcomes.map((o) => o.status)).toEqual(["present", "present", "present", "present"]);
    expect(lines().some((l) => l.includes(" create ") || l.includes(" add "))).toBe(false);
  });

  it("creates missing secrets with the install's replication, value on stdin only", async () => {
    const { run, calls } = fakeGcloud({ "secrets describe": [NOT_FOUND] });
    let n = 0;
    const outcomes = await ensureGeneratedSecrets(
      { ...install, replication: regional },
      { run, generate: () => `generated-value-${++n}` },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "applied", "applied", "applied"]);
    const creates = calls.filter((c) => c.line.startsWith("secrets create"));
    expect(creates).toEqual([
      {
        line: "secrets create caelo-production-internal-secret --project=acme --replication-policy=user-managed --locations=europe-west1 --data-file=- --quiet",
        stdin: "generated-value-1",
      },
      {
        line: "secrets create caelo-production-tool-approval-secret --project=acme --replication-policy=user-managed --locations=europe-west1 --data-file=- --quiet",
        stdin: "generated-value-2",
      },
      // #613 — the gateway's role passwords: fresh values, never admin_role's.
      {
        line: "secrets create caelo-production-public-role-password --project=acme --replication-policy=user-managed --locations=europe-west1 --data-file=- --quiet",
        stdin: "generated-value-3",
      },
      {
        line: "secrets create caelo-production-gateway-role-password --project=acme --replication-policy=user-managed --locations=europe-west1 --data-file=- --quiet",
        stdin: "generated-value-4",
      },
    ]);
    for (const c of calls) expect(c.line).not.toContain("generated-value");
  });

  it("migrates an operator-set plain value instead of rotating it", async () => {
    const { run, calls } = fakeGcloud({ "secrets describe": [NOT_FOUND] });
    const seed = plainGeneratedSecretSeed(
      new Map([
        ["CAELO_INTERNAL_SECRET", { kind: "value", value: "operator-set" }],
        ["CAELO_PROVIDER", { kind: "value", value: "gcp" }],
      ]),
    );
    expect(seed).toEqual({ "internal-secret": "operator-set" });
    await ensureGeneratedSecrets(
      { ...install, replication: regional, seed },
      { run, generate: () => "generated" },
    );
    const creates = calls.filter((c) => c.line.startsWith("secrets create"));
    expect(creates.map((c) => c.stdin)).toEqual([
      "operator-set",
      "generated",
      "generated",
      "generated",
    ]);
    for (const c of calls) expect(c.line).not.toContain("operator-set");
  });

  it("adds a first version to a secret that exists without one", async () => {
    const { run, calls } = fakeGcloud({
      "secrets describe": [ok("x")],
      "secrets versions list caelo-production-internal-secret": [ok("")],
      "secrets versions list caelo-production-tool-approval-secret": [ok("v/1")],
      "secrets versions list caelo-production-public-role-password": [ok("v/1")],
      "secrets versions list caelo-production-gateway-role-password": [ok("v/1")],
    });
    const outcomes = await ensureGeneratedSecrets(
      { ...install, replication: { kind: "automatic" } },
      { run, generate: () => "v" },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "present", "present", "present"]);
    expect(calls.filter((c) => c.line.startsWith("secrets versions add"))).toEqual([
      {
        line: "secrets versions add caelo-production-internal-secret --project=acme --data-file=-",
        stdin: "v",
      },
    ]);
  });

  it("reports a failure without creating anything when the secret can't be read", async () => {
    const { run, lines } = fakeGcloud({
      "secrets describe": [fail("PERMISSION_DENIED: secretmanager.secrets.get")],
    });
    const outcomes = await ensureGeneratedSecrets({ ...install, replication: regional }, { run });
    expect(outcomes.every((o) => o.status === "failed")).toBe(true);
    expect(lines().some((l) => l.includes(" create "))).toBe(false);
  });
});

describe("rotationRefusal", () => {
  it("rotates every database role's password and the generated secrets", () => {
    for (const s of [
      "postgres-password",
      "public-role-password",
      "gateway-role-password",
      "internal-secret",
      "tool-approval-secret",
    ]) {
      expect(rotationRefusal(s)).toBeNull();
    }
  });

  it("refuses the KEK (re-encryption needed) and secrets nothing reads", () => {
    expect(rotationRefusal("secret-kek")).toContain("re-encryption");
    expect(rotationRefusal("csrf-secret")).toContain("Rotatable");
  });
});

describe("rotateRuntimeSecret", () => {
  const target = {
    projectId: "acme",
    region: "europe-west1",
    env: "production",
    services: { admin: "adm-svc", gateway: "gw-svc" },
    sqlInstance: "caelo-production-pg-1",
  };
  const ref = (name: string, secret: string, version = "latest") => ({
    name,
    valueFrom: { secretKeyRef: { name: `caelo-production-${secret}`, key: version } },
  });
  const service = (env: unknown[]) =>
    ok(JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } }));
  /** Both services as upgrade leaves them: every secret var a reference at latest. */
  const converged = () => ({
    "run services describe adm-svc": [
      service([
        ref("ADMIN_DATABASE_PASSWORD", "postgres-password"),
        ref("PUBLIC_ADMIN_DATABASE_PASSWORD", "postgres-password"),
        ref("CAELO_SECRET_KEK", "secret-kek"),
        ref("CAELO_INTERNAL_SECRET", "internal-secret"),
        ref("CAELO_TOOL_APPROVAL_SECRET", "tool-approval-secret"),
      ]),
    ],
    "run services describe gw-svc": [
      service([
        ref("GATEWAY_DATABASE_PASSWORD", "gateway-role-password"),
        ref("PUBLIC_DATABASE_PASSWORD", "public-role-password"),
      ]),
    ],
    "auth print-access-token": [ok("tok\n")],
  });

  /** Fake Cloud SQL Admin API: every update finishes at once; records requests. */
  function fakeSqlApi(failRole?: string) {
    const requests: { url: string; method: string; body?: string; auth?: string }[] = [];
    const http: HttpFetch = async (url, init) => {
      requests.push({
        url,
        method: init.method,
        ...(init.body ? { body: init.body } : {}),
        ...(init.headers.Authorization ? { auth: init.headers.Authorization } : {}),
      });
      if (failRole && url.endsWith(`name=${failRole}`)) {
        return { ok: false, status: 403, text: async () => "PERMISSION_DENIED" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ name: "op", status: "DONE" }),
      };
    };
    const passwords = () =>
      requests
        .filter((r) => r.method === "PUT")
        .map((r) => {
          const body = JSON.parse(r.body ?? "{}") as { name: string; password: string };
          return `${body.name} ${body.password}`;
        });
    return { http, requests, passwords };
  }

  it("postgres-password: admin_role first (via the API, not argv), then the new version, then rolls the admin only", async () => {
    const { run, calls, lines } = fakeGcloud({
      ...converged(),
      "secrets versions access": [ok("old-pw")],
    });
    const sql = fakeSqlApi();
    const report = await rotateRuntimeSecret(target, "postgres-password", {
      run,
      http: sql.http,
      sleep: async () => {},
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(true);
    // #613 — admin_role's password is admin_role's alone.
    expect(sql.passwords()).toEqual(["admin_role new-pw"]);
    expect(sql.requests[0]?.url).toBe(
      "https://sqladmin.googleapis.com/v1/projects/acme/instances/caelo-production-pg-1/users?name=admin_role",
    );
    expect(sql.requests[0]?.auth).toBe("Bearer tok");
    expect(lines().some((l) => l.includes("new-pw") || l.includes("old-pw"))).toBe(false);
    const order = lines()
      .filter((l) => !l.startsWith("run services describe") && !l.startsWith("auth "))
      .map((l) => l.split(" --")[0]);
    expect(order).toEqual([
      "secrets versions access latest",
      "secrets versions add caelo-production-postgres-password",
      "run services update adm-svc",
      "run services update-traffic adm-svc",
    ]);
    expect(calls.find((c) => c.line.startsWith("secrets versions add"))?.stdin).toBe("new-pw");
    expect(
      lines()
        .filter((l) => l.startsWith("run services update "))
        .every((l) => /--update-labels=caelo-secret-rotated=\d+/.test(l)),
    ).toBe(true);
  });

  it("gateway-role-password: changes gateway_role only and rolls the gateway only (#613)", async () => {
    const { run, lines } = fakeGcloud({
      ...converged(),
      "secrets versions access": [ok("old-pw")],
    });
    const sql = fakeSqlApi();
    const report = await rotateRuntimeSecret(target, "gateway-role-password", {
      run,
      http: sql.http,
      sleep: async () => {},
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(true);
    expect(sql.passwords()).toEqual(["gateway_role new-pw"]);
    expect(lines().filter((l) => l.startsWith("run services update "))).toEqual([
      expect.stringContaining("run services update gw-svc"),
    ]);
    expect(lines()).toContain(
      "secrets versions access latest --secret=caelo-production-gateway-role-password --project=acme",
    );
  });

  it("public-role-password: stores nothing and rolls nothing when public_role can't be changed", async () => {
    const { run, lines } = fakeGcloud({
      ...converged(),
      "secrets versions access": [ok("old-pw")],
    });
    const sql = fakeSqlApi("public_role");
    const report = await rotateRuntimeSecret(target, "public-role-password", {
      run,
      http: sql.http,
      sleep: async () => {},
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("set the public_role password");
    expect(sql.passwords()).toEqual(["public_role new-pw"]);
    expect(lines().some((l) => l.startsWith("secrets versions add"))).toBe(false);
    expect(lines().some((l) => l.startsWith("run services update"))).toBe(false);
  });

  it("refuses postgres-password while the gateway still reads it (an install from before #613)", async () => {
    const answers = converged();
    answers["run services describe gw-svc"] = [
      service([
        ref("ADMIN_DATABASE_PASSWORD", "postgres-password"),
        ref("PUBLIC_DATABASE_PASSWORD", "postgres-password"),
      ]),
    ];
    const { run, lines } = fakeGcloud(answers);
    const sql = fakeSqlApi();
    const report = await rotateRuntimeSecret(target, "postgres-password", {
      run,
      http: sql.http,
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("ADMIN_DATABASE_PASSWORD");
    expect(report.error).toContain("Run `cms-provision upgrade` first");
    expect(sql.requests).toHaveLength(0);
    expect(lines().every((l) => l.startsWith("run services describe"))).toBe(true);
  });

  it("refuses before changing anything on an install upgrade hasn't moved over", async () => {
    const { run, lines } = fakeGcloud({
      "run services describe adm-svc": [
        service([
          { name: "ADMIN_DATABASE_URL", value: "postgres://admin_role:pw@10.0.0.3:5432/cms_admin" },
        ]),
      ],
    });
    const sql = fakeSqlApi();
    const report = await rotateRuntimeSecret(target, "postgres-password", {
      run,
      http: sql.http,
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("Run `cms-provision upgrade` first");
    expect(sql.requests).toHaveLength(0);
    expect(lines().every((l) => l.startsWith("run services describe"))).toBe(true);
  });

  it("refuses a reader pinned to an older secret version", async () => {
    const answers = converged();
    answers["run services describe adm-svc"] = [
      service([ref("CAELO_INTERNAL_SECRET", "internal-secret", "3")]),
    ];
    const { run, lines } = fakeGcloud(answers);
    const report = await rotateRuntimeSecret(target, "internal-secret", {
      run,
      generate: () => "v",
    });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("CAELO_INTERNAL_SECRET");
    expect(lines().some((l) => l.startsWith("secrets versions add"))).toBe(false);
  });

  it("says how to resume when the roll fails after the database took the new value", async () => {
    const { run } = fakeGcloud({
      ...converged(),
      "secrets versions access": [ok("old-pw")],
      "run services update gw-svc": [fail("revision failed")],
    });
    const report = await rotateRuntimeSecret(target, "public-role-password", {
      run,
      http: fakeSqlApi().http,
      sleep: async () => {},
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("the database uses it");
    expect(report.error).toContain("Do not rotate again");
    expect(report.error).toContain("gcloud run services update gw-svc");
    expect(report.steps).toContain("set a new password on database role public_role");
  });

  it("an admin-only secret rolls only the admin", async () => {
    const { run, lines } = fakeGcloud(converged());
    const report = await rotateRuntimeSecret(target, "internal-secret", {
      run,
      generate: () => "v",
    });
    expect(report.ok).toBe(true);
    expect(lines().filter((l) => l.startsWith("run services update "))).toHaveLength(1);
    expect(lines().some((l) => l.startsWith("run services update gw-svc"))).toBe(false);
    expect(lines().some((l) => l.startsWith("sql "))).toBe(false);
  });
});

describe("parseAdminConfig", () => {
  const admin = (env: unknown[]) =>
    JSON.stringify({
      spec: {
        template: {
          metadata: {
            annotations: {
              "run.googleapis.com/network-interfaces": JSON.stringify([
                { network: "net", subnetwork: "sub" },
              ]),
            },
          },
          spec: { containers: [{ image: "img@sha256:x", env }] },
        },
      },
    });

  it("marks an admin still on an inline-password URL (jobs on its image need upgrade first)", () => {
    const cfg = parseAdminConfig(
      admin([
        { name: "ADMIN_DATABASE_URL", value: "postgres://admin_role:pw@10.0.0.3:5432/cms_admin" },
      ]),
    );
    expect(cfg?.databaseHost).toBe("10.0.0.3");
    expect(cfg?.secretEnv).toBe(false);
  });

  it("marks an admin that reads the password from Secret Manager", () => {
    const cfg = parseAdminConfig(
      admin([
        { name: "ADMIN_DATABASE_URL", value: "postgresql://admin_role@10.0.0.3:5432/cms_admin" },
        {
          name: "ADMIN_DATABASE_PASSWORD",
          valueFrom: {
            secretKeyRef: { name: "caelo-production-postgres-password", key: "latest" },
          },
        },
      ]),
    );
    expect(cfg?.secretEnv).toBe(true);
  });
});

describe("migrationJobEnvArgs", () => {
  it("gives the job password-less URLs and the password as a secret reference", () => {
    const args = migrationJobEnvArgs("10.20.0.3");
    expect(args).toEqual([
      "--set-env-vars=ADMIN_DATABASE_URL=postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require,PUBLIC_ADMIN_DATABASE_URL=postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
      "--set-secrets=ADMIN_DATABASE_PASSWORD=caelo-production-postgres-password:latest,PUBLIC_ADMIN_DATABASE_PASSWORD=caelo-production-postgres-password:latest",
    ]);
  });
});
