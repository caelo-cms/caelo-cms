// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader's IAM self-check (#818): which permissions it asks for, how
 * it groups and judges IAM's answers, the exact REST calls it makes, and
 * that it never asks for a permission upgrader-setup.ts does not grant (a
 * check the setup cannot pass would stop every update).
 */

import { describe, expect, it } from "bun:test";
import type { HttpFetch } from "./runtime-secrets.js";
import {
  type IamResource,
  type IamTester,
  objectProbeCall,
  PREFLIGHT_PROBE_OBJECT,
  preflightMissingReason,
  resourceName,
  restIamTester,
  runIamPreflight,
  testIamCall,
  upgraderAccessChecks,
} from "./upgrader-iam-preflight.js";
import {
  UPGRADER_FORBIDDEN_ROLES,
  UPGRADER_OPS_LIST_ROLE,
  UPGRADER_PROJECT_ROLES,
  UPGRADER_SQL_BACKUP_ROLE,
} from "./upgrader-setup.js";

const TARGET = { projectId: "acme", region: "europe-west1", env: "production" };

/**
 * The permissions of the predefined roles upgrader-setup.ts grants, as far
 * as the self-check needs them (cloud.google.com/run/docs/reference/iam/roles,
 * cloud.google.com/iam/docs/understanding-roles). Only the ones asked for
 * are listed; a new check must find its permission here or in a custom role.
 */
const PREDEFINED: Record<string, readonly string[]> = {
  "roles/run.developer": [
    "run.services.get",
    "run.services.list",
    "run.services.update",
    "run.revisions.get",
    "run.revisions.list",
    "run.operations.get",
    "run.jobs.create",
    "run.jobs.delete",
    "run.jobs.get",
    "run.jobs.run",
    "run.jobs.update",
    "run.executions.get",
  ],
  "roles/cloudsql.instanceUser": ["cloudsql.instances.get", "cloudsql.instances.login"],
  "roles/logging.logWriter": ["logging.logEntries.create"],
  "roles/iam.serviceAccountUser": ["iam.serviceAccounts.actAs"],
  "roles/iam.serviceAccountTokenCreator": ["iam.serviceAccounts.signJwt"],
  "roles/storage.objectUser": [
    "storage.objects.get",
    "storage.objects.create",
    "storage.objects.delete",
    "storage.objects.list",
  ],
  // The public release mirror grants allUsers roles/artifactregistry.reader.
  "roles/artifactregistry.reader": ["artifactregistry.repositories.downloadArtifacts"],
};

/** What upgrader-setup.ts grants the upgrader's account, per resource name. */
function setupGrants(): Map<string, Set<string>> {
  const p = TARGET.projectId;
  const of = (...roles: string[]) => new Set(roles.flatMap((r) => PREDEFINED[r] ?? []));
  const project = of(...UPGRADER_PROJECT_ROLES);
  for (const perm of UPGRADER_SQL_BACKUP_ROLE.permissions) project.add(perm);
  const bucketList = new Set(UPGRADER_OPS_LIST_ROLE.permissions);
  return new Map([
    [`projects/${p}`, project],
    [
      `projects/${p}/serviceAccounts/caelo-production-run-sa@${p}.iam.gserviceaccount.com`,
      of("roles/iam.serviceAccountUser"),
    ],
    [
      `projects/${p}/serviceAccounts/caelo-production-gateway-sa@${p}.iam.gserviceaccount.com`,
      of("roles/iam.serviceAccountUser"),
    ],
    [
      `projects/${p}/serviceAccounts/caelo-production-upgrader@${p}.iam.gserviceaccount.com`,
      of("roles/iam.serviceAccountUser"),
    ],
    [
      `projects/${p}/serviceAccounts/caelo-mcp@${p}.iam.gserviceaccount.com`,
      of("roles/iam.serviceAccountTokenCreator"),
    ],
    // Project-level run.developer reaches the job too.
    [`projects/${p}/locations/europe-west1/jobs/caelo-production-upgrader`, project],
    [`gs://${p}-caelo-ops`, bucketList],
    // The install/-conditioned roles/storage.objectUser grant.
    [`gs://${p}-caelo-ops/install/`, of("roles/storage.objectUser")],
    [
      "projects/caelo-website/locations/europe-west1/repositories/caelo-cms-images",
      of("roles/artifactregistry.reader"),
    ],
  ]);
}

/** A tester answering from `grants`, recording every question. */
function tester(grants: Map<string, Set<string>>, asked: string[] = []): IamTester {
  return {
    granted: async (resource, permissions) => {
      asked.push(`${resourceName(resource)} ${permissions.join(",")}`);
      const held = grants.get(resourceName(resource)) ?? new Set<string>();
      return { ok: true, granted: permissions.filter((x) => held.has(x)) };
    },
  };
}

describe("upgraderAccessChecks", () => {
  it("asks only for what upgrader-setup.ts grants: a fresh setup passes the self-check", async () => {
    const r = await runIamPreflight(upgraderAccessChecks(TARGET), tester(setupGrants()));
    expect(r).toEqual({ kind: "ok" });
  });

  it("never needs a permission only a forbidden role would give (no compute, no IAM admin)", () => {
    const all = upgraderAccessChecks(TARGET).flatMap((c) => c.permissions);
    for (const p of all) {
      expect(p.startsWith("compute.")).toBe(false);
      expect(p.endsWith(".setIamPolicy")).toBe(false);
    }
    // Sanity: the forbidden list still bans compute (the Direct VPC decision).
    expect(UPGRADER_FORBIDDEN_ROLES).toContain("roles/compute.");
  });

  it("covers every step the run takes after its decision", () => {
    const all = new Set(upgraderAccessChecks(TARGET).flatMap((c) => c.permissions));
    for (const p of [
      "run.services.update", // the roll + traffic
      "run.jobs.create", // the migration job
      "run.jobs.run",
      "run.executions.get", // execute --wait, the lock lease
      "run.jobs.update", // the self-update
      "cloudsql.backupRuns.create", // the backup
      "iam.serviceAccounts.actAs",
      "iam.serviceAccounts.signJwt", // the IAP health check
      "storage.objects.list", // gcloud storage cp lists first (#799)
      "storage.objects.create",
      "storage.objects.delete", // overwrite + lock release
      "artifactregistry.repositories.downloadArtifacts",
    ]) {
      expect(all.has(p)).toBe(true);
    }
  });
});

describe("runIamPreflight", () => {
  it("asks once per resource, with every permission the checks on it need", async () => {
    const asked: string[] = [];
    await runIamPreflight(upgraderAccessChecks(TARGET), tester(setupGrants(), asked));
    const names = asked.map((a) => a.split(" ")[0]);
    expect(new Set(names).size).toBe(names.length);
    const project = asked.find((a) => a.startsWith("projects/acme "));
    expect(project).toContain("run.services.update");
    expect(project).toContain("cloudsql.backupRuns.create");
  });

  it("names every missing permission, per need, in one outcome", async () => {
    const grants = setupGrants();
    grants.get("projects/acme")?.delete("run.jobs.run");
    grants.get("projects/acme")?.delete("cloudsql.backupRuns.create");
    grants.get("gs://acme-caelo-ops")?.delete("storage.objects.list");
    const r = await runIamPreflight(upgraderAccessChecks(TARGET), tester(grants));
    expect(r.kind).toBe("missing");
    if (r.kind !== "missing") return;
    expect(r.missing.flatMap((m) => m.missing).sort()).toEqual([
      "cloudsql.backupRuns.create",
      "run.jobs.run",
      "storage.objects.list",
    ]);
    const reason = preflightMissingReason(r.missing);
    expect(reason).toContain("run the database migrations");
    expect(reason).toContain("missing storage.objects.list on gs://acme-caelo-ops");
    expect(reason).toContain("Run the upgrade once with Cloud Shell");
  });

  it("an unanswerable resource is an error, never 'nothing missing'", async () => {
    const failing: IamTester = {
      granted: async (resource) =>
        resource.kind === "artifact-repository"
          ? { ok: false, error: "HTTP 403 caller has no access" }
          : { ok: true, granted: [] },
    };
    const r = await runIamPreflight(upgraderAccessChecks(TARGET), failing);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.errors[0]).toContain("HTTP 403");
  });

  it("a tester that throws is an error too", async () => {
    const throwing: IamTester = {
      granted: async () => {
        throw new Error("socket hang up");
      },
    };
    const r = await runIamPreflight(
      [{ need: "x", resource: { kind: "project", projectId: "p" }, permissions: ["a.b.c"] }],
      throwing,
    );
    expect(r).toEqual({ kind: "error", errors: ["projects/p: socket hang up"] });
  });
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** An HTTP client answering by method + URL prefix. */
function http(calls: Call[], answer: (c: Call) => { status: number; body: string }): HttpFetch {
  return async (url, init) => {
    const call = { url, ...init };
    calls.push(call);
    const a = answer(call);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
  };
}

describe("restIamTester", () => {
  it("calls each API's testIamPermissions with the job's token", async () => {
    const calls: Call[] = [];
    const t = restIamTester({
      http: http(calls, () => ({ status: 200, body: JSON.stringify({ permissions: ["a.b.c"] }) })),
      token: async () => "tok",
    });
    const resources: IamResource[] = [
      { kind: "project", projectId: "acme" },
      { kind: "service-account", projectId: "acme", email: "x@acme.iam.gserviceaccount.com" },
      {
        kind: "run-job",
        projectId: "acme",
        region: "europe-west1",
        name: "caelo-production-upgrader",
      },
      { kind: "bucket", bucket: "acme-caelo-ops" },
      {
        kind: "artifact-repository",
        projectId: "caelo-website",
        location: "europe-west1",
        repository: "caelo-cms-images",
      },
    ];
    for (const res of resources) {
      expect(await t.granted(res, ["a.b.c", "d.e.f"])).toEqual({ ok: true, granted: ["a.b.c"] });
    }
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://cloudresourcemanager.googleapis.com/v1/projects/acme:testIamPermissions",
      "POST https://iam.googleapis.com/v1/projects/acme/serviceAccounts/x%40acme.iam.gserviceaccount.com:testIamPermissions",
      "POST https://run.googleapis.com/v2/projects/acme/locations/europe-west1/jobs/caelo-production-upgrader:testIamPermissions",
      "GET https://storage.googleapis.com/storage/v1/b/acme-caelo-ops/iam/testPermissions?permissions=a.b.c&permissions=d.e.f",
      "POST https://artifactregistry.googleapis.com/v1/projects/caelo-website/locations/europe-west1/repositories/caelo-cms-images:testIamPermissions",
    ]);
    for (const c of calls) expect(c.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ permissions: ["a.b.c", "d.e.f"] });
    expect(calls[3]?.body).toBeUndefined();
  });

  it("an answer without `permissions` means none is held", async () => {
    const t = restIamTester({
      http: http([], () => ({ status: 200, body: "{}" })),
      token: async () => "tok",
    });
    expect(await t.granted({ kind: "project", projectId: "acme" }, ["a.b.c"])).toEqual({
      ok: true,
      granted: [],
    });
  });

  it("an HTTP error or non-JSON answer is an error, not 'missing'", async () => {
    const denied = restIamTester({
      http: http([], () => ({ status: 403, body: "PERMISSION_DENIED" })),
      token: async () => "tok",
    });
    const r = await denied.granted({ kind: "project", projectId: "acme" }, ["a.b.c"]);
    expect(r).toEqual({ ok: false, error: "HTTP 403 PERMISSION_DENIED" });
    const garbled = restIamTester({
      http: http([], () => ({ status: 200, body: "<html>" })),
      token: async () => "tok",
    });
    expect((await garbled.granted({ kind: "project", projectId: "acme" }, ["a"])).ok).toBe(false);
  });

  it("an empty token is an error before any call", async () => {
    const calls: Call[] = [];
    const t = restIamTester({
      http: http(calls, () => ({ status: 200, body: "{}" })),
      token: async () => "",
    });
    expect((await t.granted({ kind: "project", projectId: "acme" }, ["a"])).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("install/ object probes", () => {
  const objects: Extract<IamResource, { kind: "bucket-objects" }> = {
    kind: "bucket-objects",
    bucket: "acme-caelo-ops",
    prefix: "install",
  };
  const PERMS = ["storage.objects.get", "storage.objects.create", "storage.objects.delete"];

  it("every write probe is preconditioned on generation 1, so it can never change anything", () => {
    const create = objectProbeCall(objects, "storage.objects.create");
    const del = objectProbeCall(objects, "storage.objects.delete");
    expect(create?.url).toContain("ifGenerationMatch=1");
    expect(del?.url).toContain("ifGenerationMatch=1");
    for (const c of [create, del, objectProbeCall(objects, "storage.objects.get")]) {
      expect(c?.url).toContain(encodeURIComponent(`install/${PREFLIGHT_PROBE_OBJECT}`));
    }
    expect(objectProbeCall(objects, "storage.objects.list")).toBeNull();
  });

  it("404/412 is held, 403 is missing", async () => {
    const calls: Call[] = [];
    const t = restIamTester({
      http: http(calls, (c) =>
        c.method === "GET"
          ? { status: 404, body: "No such object" }
          : c.method === "POST"
            ? { status: 412, body: "conditionNotMet" }
            : { status: 403, body: "does not have storage.objects.delete access" },
      ),
      token: async () => "tok",
    });
    expect(await t.granted(objects, PERMS)).toEqual({
      ok: true,
      granted: ["storage.objects.get", "storage.objects.create"],
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "DELETE"]);
  });

  it("an upload that succeeded (never expected) is an error, loudly", async () => {
    const t = restIamTester({
      http: http([], (c) =>
        c.method === "POST" ? { status: 200, body: "{}" } : { status: 404, body: "" },
      ),
      token: async () => "tok",
    });
    const r = await t.granted(objects, PERMS);
    expect(r.ok).toBe(false);
  });

  it("a permission without a probe is an error", async () => {
    const t = restIamTester({
      http: http([], () => ({ status: 404, body: "" })),
      token: async () => "tok",
    });
    expect((await t.granted(objects, ["storage.objects.update"])).ok).toBe(false);
  });
});

describe("testIamCall", () => {
  it("URL-encodes path parts", () => {
    const c = testIamCall({ kind: "bucket", bucket: "a b" }, ["x"]);
    expect(c.url).toContain("/b/a%20b/");
  });
});
