// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { migrationJobEnvArgs } from "./migration-runner.js";
import {
  ensureGatewayServiceAccount,
  ensureGeneratedSecrets,
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

  it("is a read-only no-op when both secrets have an enabled version", async () => {
    const { run, lines } = fakeGcloud({
      "secrets describe": [ok("projects/1/secrets/x")],
      "secrets versions list": [ok("projects/1/secrets/x/versions/1")],
    });
    const outcomes = await ensureGeneratedSecrets({ ...install, replication: regional }, { run });
    expect(outcomes.map((o) => o.status)).toEqual(["present", "present"]);
    expect(lines().some((l) => l.includes(" create ") || l.includes(" add "))).toBe(false);
  });

  it("creates missing secrets with the install's replication, value on stdin only", async () => {
    const { run, calls } = fakeGcloud({ "secrets describe": [NOT_FOUND] });
    let n = 0;
    const outcomes = await ensureGeneratedSecrets(
      { ...install, replication: regional },
      { run, generate: () => `generated-value-${++n}` },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "applied"]);
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
    ]);
    for (const c of calls) expect(c.line).not.toContain("generated-value");
  });

  it("adds a first version to a secret that exists without one", async () => {
    const { run, calls } = fakeGcloud({
      "secrets describe": [ok("x")],
      "secrets versions list caelo-production-internal-secret": [ok("")],
      "secrets versions list caelo-production-tool-approval-secret": [ok("v/1")],
    });
    const outcomes = await ensureGeneratedSecrets(
      { ...install, replication: { kind: "automatic" } },
      { run, generate: () => "v" },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "present"]);
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
  it("rotates the database password and the generated secrets", () => {
    for (const s of ["postgres-password", "internal-secret", "tool-approval-secret"]) {
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

  it("postgres-password: roles first, then the new version, then rolls both services", async () => {
    const { run, calls, lines } = fakeGcloud({ "secrets versions access": [ok("old-pw")] });
    const report = await rotateRuntimeSecret(target, "postgres-password", {
      run,
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(true);
    const order = lines().map((l) => l.split(" --")[0]);
    expect(order).toEqual([
      "secrets versions access latest",
      "sql users set-password admin_role",
      "sql users set-password public_role",
      "secrets versions add caelo-production-postgres-password",
      "run services update adm-svc",
      "run services update-traffic adm-svc",
      "run services update gw-svc",
      "run services update-traffic gw-svc",
    ]);
    expect(calls.find((c) => c.line.startsWith("secrets versions add"))?.stdin).toBe("new-pw");
    expect(
      lines()
        .filter((l) => l.startsWith("run services update "))
        .every((l) => /--update-labels=caelo-secret-rotated=\d+/.test(l)),
    ).toBe(true);
  });

  it("postgres-password: sets admin_role back when public_role can't be changed", async () => {
    const { run, lines } = fakeGcloud({
      "secrets versions access": [ok("old-pw")],
      "sql users set-password public_role": [fail("PERMISSION_DENIED")],
    });
    const report = await rotateRuntimeSecret(target, "postgres-password", {
      run,
      generate: () => "new-pw",
    });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("set back to the previous password");
    const setPw = lines().filter((l) => l.startsWith("sql users set-password"));
    expect(setPw.map((l) => `${l.split(" ")[3]} ${l.match(/--password=(\S+)/)?.[1]}`)).toEqual([
      "admin_role new-pw",
      "public_role new-pw",
      "admin_role old-pw",
    ]);
    expect(lines().some((l) => l.startsWith("secrets versions add"))).toBe(false);
    expect(lines().some((l) => l.startsWith("run services"))).toBe(false);
  });

  it("an admin-only secret rolls only the admin", async () => {
    const { run, lines } = fakeGcloud({});
    const report = await rotateRuntimeSecret(target, "internal-secret", {
      run,
      generate: () => "v",
    });
    expect(report.ok).toBe(true);
    expect(lines().filter((l) => l.startsWith("run services update "))).toHaveLength(1);
    expect(lines().some((l) => l.includes("gw-svc"))).toBe(false);
    expect(lines().some((l) => l.startsWith("sql "))).toBe(false);
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
