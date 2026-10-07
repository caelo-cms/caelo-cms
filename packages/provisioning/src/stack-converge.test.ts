// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { STATIC_CDN_POLICY, stackIamInvariants } from "./stack-contract.js";
import {
  ensureStackInvariants,
  type InstallTarget,
  type LiveEnvValue,
  liveContainerEnv,
  liveDatabaseHost,
  liveServiceAccount,
  planContractEnv,
  planEnvUpdate,
  policyGrants,
  rollService,
  serviceRollArgs,
} from "./stack-converge.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/**
 * Fake gcloud: answers by the longest matching command prefix (queue per
 * prefix, then the prefix's last answer repeats); records every call.
 */
function fakeGcloud(answers: Record<string, GcloudResult[]>, fallback: GcloudResult = ok("{}")) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const queue = key ? answers[key] : undefined;
    if (!queue || queue.length === 0) return fallback;
    return queue.length > 1 ? (queue.shift() as GcloudResult) : (queue[0] as GcloudResult);
  };
  return { run, calls };
}

const policy = (bindings: { role: string; members: string[]; condition?: unknown }[]) =>
  ok(JSON.stringify({ bindings }));

const RUN_SA = "serviceAccount:caelo-production-run-sa@acme.iam.gserviceaccount.com";
const GW_SA = "serviceAccount:caelo-production-gateway-sa@acme.iam.gserviceaccount.com";
const GW_TELEMETRY = [
  { role: "roles/logging.logWriter", members: [GW_SA] },
  { role: "roles/monitoring.metricWriter", members: [GW_SA] },
];
const IAP_AGENT = "serviceAccount:service-42@gcp-sa-iap.iam.gserviceaccount.com";

const firebase: InstallTarget = {
  provider: "gcp-firebase",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  services: { admin: "caelo-production-admin-aaa", gateway: "caelo-production-gateway-bbb" },
};
const gcp: InstallTarget = { ...firebase, provider: "gcp" };

const serviceJson = (env: unknown[]) =>
  JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } });

describe("liveContainerEnv", () => {
  it("reads plain values and secret references from a Knative service", () => {
    const env = liveContainerEnv(
      serviceJson([
        { name: "CAELO_ENV", value: "production" },
        {
          name: "CAELO_SECRET_KEK",
          valueFrom: { secretKeyRef: { name: "caelo-production-secret-kek", key: "latest" } },
        },
      ]),
    );
    expect(env.get("CAELO_ENV")).toEqual({ kind: "value", value: "production" });
    expect(env.get("CAELO_SECRET_KEK")).toEqual({
      kind: "secret",
      secret: "caelo-production-secret-kek",
      version: "latest",
    });
  });
});

describe("liveContainerEnv / liveServiceAccount / liveDatabaseHost", () => {
  it("normalises a fully qualified secret name to its id", () => {
    const env = liveContainerEnv(
      serviceJson([
        {
          name: "X",
          valueFrom: {
            secretKeyRef: { name: "projects/123/secrets/caelo-production-x", key: "latest" },
          },
        },
      ]),
    );
    expect(env.get("X")).toEqual({
      kind: "secret",
      secret: "caelo-production-x",
      version: "latest",
    });
  });

  it("reads the revision service account", () => {
    const json = JSON.stringify({
      spec: { template: { spec: { serviceAccountName: "a@p.iam.gserviceaccount.com" } } },
    });
    expect(liveServiceAccount(json)).toBe("a@p.iam.gserviceaccount.com");
    expect(liveServiceAccount("{}")).toBeUndefined();
  });

  it("finds the Cloud SQL host in ADMIN_DATABASE_URL with or without an inline password", () => {
    for (const url of [
      "postgresql://admin_role:pw@10.20.0.3:5432/cms_admin?sslmode=require",
      "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
    ]) {
      const host = liveDatabaseHost(
        new Map([["ADMIN_DATABASE_URL", { kind: "value", value: url }]]),
      );
      expect(host).toEqual({ ok: true, host: "10.20.0.3" });
    }
    expect(liveDatabaseHost(new Map()).ok).toBe(false);
  });
});

describe("planEnvUpdate", () => {
  const live = new Map<string, LiveEnvValue>([
    ["CAELO_ENV", { kind: "value", value: "production" }],
    ["CAELO_SECRET_KEK", { kind: "secret", secret: "kek", version: "latest" }],
  ]);

  it("touches only vars that differ", () => {
    const plan = planEnvUpdate(live, [
      { name: "CAELO_ENV", value: "production" },
      { name: "CAELO_SITE_URL", value: "https://acme.com" },
    ]);
    expect(plan).toEqual({
      ok: true,
      changes: [{ name: "CAELO_SITE_URL", from: undefined, to: "https://acme.com" }],
      flags: ["--update-env-vars=CAELO_SITE_URL=https://acme.com"],
    });
  });

  it("is empty when the service already matches", () => {
    expect(planEnvUpdate(live, [{ name: "CAELO_ENV", value: "production" }])).toEqual({
      ok: true,
      changes: [],
      flags: [],
    });
  });

  it("renders Secret Manager references as --update-secrets", () => {
    const plan = planEnvUpdate(live, [
      {
        name: "CAELO_SECRET_KEK",
        valueSource: { secretKeyRef: { secret: "kek", version: "latest" } },
      },
      { name: "CSRF", valueSource: { secretKeyRef: { secret: "csrf", version: "3" } } },
    ]);
    expect(plan.ok && plan.flags).toEqual(["--update-secrets=CSRF=csrf:3"]);
  });

  it("moves a plain var to a secret reference inside the same update, never printing the old value", () => {
    const withPlainSecret = new Map<string, LiveEnvValue>([
      ["CAELO_INTERNAL_SECRET", { kind: "value", value: "hand-set-plaintext" }],
    ]);
    const plan = planEnvUpdate(withPlainSecret, [
      {
        name: "CAELO_INTERNAL_SECRET",
        valueSource: { secretKeyRef: { secret: "internal", version: "latest" } },
      },
    ]);
    expect(plan).toEqual({
      ok: true,
      changes: [
        { name: "CAELO_INTERNAL_SECRET", from: "(plain value)", to: "secret:internal:latest" },
      ],
      flags: [
        "--remove-env-vars=CAELO_INTERNAL_SECRET",
        "--update-secrets=CAELO_INTERNAL_SECRET=internal:latest",
      ],
    });
    expect(JSON.stringify(plan)).not.toContain("hand-set-plaintext");
  });

  it("refuses to flip a secret reference to a plain value (gcloud can't do it in one revision)", () => {
    const toPlain = planEnvUpdate(live, [{ name: "CAELO_SECRET_KEK", value: "raw" }]);
    expect(toPlain.ok).toBe(false);
  });

  it("removes retired vars of either kind", () => {
    const plan = planEnvUpdate(
      new Map<string, LiveEnvValue>([
        ["OLD_PLAIN", { kind: "value", value: "x" }],
        ["CAELO_SECRET_KEK", { kind: "secret", secret: "kek", version: "latest" }],
      ]),
      [],
      ["OLD_PLAIN", "CAELO_SECRET_KEK", "NEVER_SET"],
    );
    expect(plan).toEqual({
      ok: true,
      changes: [
        { name: "OLD_PLAIN", from: "x", to: undefined },
        { name: "CAELO_SECRET_KEK", from: "secret:kek:latest", to: undefined },
      ],
      flags: ["--remove-env-vars=OLD_PLAIN", "--remove-secrets=CAELO_SECRET_KEK"],
    });
  });

  it("masks a password in a URL it reports as the old value", () => {
    const plan = planEnvUpdate(
      new Map<string, LiveEnvValue>([
        ["ADMIN_DATABASE_URL", { kind: "value", value: "postgres://admin_role:hunter2@h:5432/db" }],
      ]),
      [{ name: "ADMIN_DATABASE_URL", value: "postgresql://admin_role@h:5432/db" }],
    );
    expect(plan.ok && plan.changes[0]?.from).toBe("postgres://admin_role:***@h:5432/db");
    expect(JSON.stringify(plan)).not.toContain("hunter2");
  });

  it("escapes values containing commas", () => {
    const plan = planEnvUpdate(new Map(), [
      { name: "A", value: "x,y" },
      { name: "B", value: "z" },
    ]);
    expect(plan.ok && plan.flags).toEqual(["--update-env-vars=^@^A=x,y@B=z"]);
  });
});

/** The env a service carries once this contract applied (database + secrets). */
const secretRef = (name: string, secret: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: `caelo-production-${secret}`, key: "latest" } },
});
const CONVERGED_ADMIN_DB = [
  {
    name: "ADMIN_DATABASE_URL",
    value: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
  },
  {
    name: "PUBLIC_ADMIN_DATABASE_URL",
    value: "postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
  },
  secretRef("ADMIN_DATABASE_PASSWORD", "postgres-password"),
  secretRef("PUBLIC_ADMIN_DATABASE_PASSWORD", "postgres-password"),
  secretRef("CAELO_SECRET_KEK", "secret-kek"),
  secretRef("CAELO_INTERNAL_SECRET", "internal-secret"),
  secretRef("CAELO_TOOL_APPROVAL_SECRET", "tool-approval-secret"),
];
const CONVERGED_GATEWAY_DB = [
  {
    name: "PUBLIC_DATABASE_URL",
    value: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
  },
  {
    name: "ADMIN_DATABASE_URL",
    value: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
  },
  secretRef("PUBLIC_DATABASE_PASSWORD", "postgres-password"),
  secretRef("ADMIN_DATABASE_PASSWORD", "postgres-password"),
];

describe("planContractEnv", () => {
  it("regression A1: an install without CAELO_SITE_URL gets it on the admin roll", () => {
    // What a pre-#551 gcp-firebase admin runs with.
    const adminLive = liveContainerEnv(
      serviceJson([
        { name: "CAELO_PROVIDER", value: "gcp-firebase" },
        { name: "CAELO_ENV", value: "production" },
        { name: "MEDIA_STORAGE_URL", value: "gs://acme-caelo-production-media" },
        { name: "CAELO_FIREBASE_SITE", value: "caelo-production-site-abc123" },
        { name: "CAELO_GENERATOR_CLI", value: "/app/apps/static-generator/src/cli.ts" },
        { name: "CAELO_GATEWAY_SERVICE", value: "caelo-production-gateway-bbb" },
        { name: "CAELO_GATEWAY_REGION", value: "europe-west1" },
        ...CONVERGED_ADMIN_DB,
      ]),
    );
    const gatewayLive = liveContainerEnv(
      serviceJson([
        { name: "CAELO_PROVIDER", value: "gcp-firebase" },
        { name: "CAELO_ENV", value: "production" },
        { name: "MEDIA_STORAGE_URL", value: "gs://acme-caelo-production-media" },
        ...CONVERGED_GATEWAY_DB,
      ]),
    );
    const plan = planContractEnv(
      {
        provider: "gcp-firebase",
        projectId: "acme",
        env: "production",
        domain: "acme.com",
        region: "europe-west1",
      },
      {
        admin: { serviceName: "caelo-production-admin-aaa", liveEnv: adminLive },
        gateway: { serviceName: "caelo-production-gateway-bbb", liveEnv: gatewayLive },
      },
    );
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.services.admin.flags).toEqual([
      "--update-env-vars=CAELO_SITE_URL=https://acme.com,CAELO_MCP_IAP_SERVICE_ACCOUNT=caelo-mcp@acme.iam.gserviceaccount.com",
    ]);
    expect(plan.services.gateway.flags).toEqual([]);
  });

  it("leaves the MCP service account untouched when upgrade couldn't set it up", () => {
    const live = liveContainerEnv(
      serviceJson([
        { name: "CAELO_FIREBASE_SITE", value: "caelo-production-site-abc123" },
        ...CONVERGED_ADMIN_DB,
      ]),
    );
    const plan = planContractEnv(
      {
        provider: "gcp-firebase",
        projectId: "acme",
        env: "production",
        domain: "acme.com",
        region: "europe-west1",
      },
      {
        admin: { serviceName: "caelo-production-admin-aaa", liveEnv: live },
        gateway: {
          serviceName: "caelo-production-gateway-bbb",
          liveEnv: liveContainerEnv(serviceJson(CONVERGED_GATEWAY_DB)),
        },
      },
      { leaveUntouched: ["CAELO_MCP_IAP_SERVICE_ACCOUNT"] },
    );
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.services.admin.changes.map((c) => c.name)).not.toContain(
      "CAELO_MCP_IAP_SERVICE_ACCOUNT",
    );
    expect(plan.services.admin.changes.map((c) => c.name)).toContain("CAELO_SITE_URL");
  });

  it("fails loudly when the Firebase site id can't be discovered", () => {
    const plan = planContractEnv(
      { provider: "gcp-firebase", projectId: "a", env: "production", domain: "a.com", region: "r" },
      {
        admin: { serviceName: "adm", liveEnv: liveContainerEnv(serviceJson(CONVERGED_ADMIN_DB)) },
        gateway: { serviceName: "gw", liveEnv: new Map() },
      },
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain("CAELO_FIREBASE_SITE");
  });

  it("fails loudly when the Cloud SQL host can't be discovered", () => {
    const plan = planContractEnv(
      { provider: "gcp", projectId: "a", env: "production", domain: "a.com", region: "r" },
      {
        admin: { serviceName: "adm", liveEnv: new Map() },
        gateway: { serviceName: "gw", liveEnv: new Map() },
      },
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain("ADMIN_DATABASE_URL");
  });
});

describe("serviceRollArgs", () => {
  it("rolls the image and applies env changes in one services update (one revision)", () => {
    expect(
      serviceRollArgs({
        serviceName: "caelo-production-admin-aaa",
        region: "europe-west1",
        projectId: "acme",
        imageRef: "img@sha256:1",
        serviceAccount: "caelo-production-run-sa@acme.iam.gserviceaccount.com",
        envFlags: ["--update-env-vars=CAELO_SITE_URL=https://acme.com"],
      }),
    ).toEqual([
      "run",
      "services",
      "update",
      "caelo-production-admin-aaa",
      "--region",
      "europe-west1",
      "--project",
      "acme",
      "--image",
      "img@sha256:1",
      "--service-account=caelo-production-run-sa@acme.iam.gserviceaccount.com",
      "--update-env-vars=CAELO_SITE_URL=https://acme.com",
      "--quiet",
    ]);
  });
});

describe("rollService", () => {
  it("retries while a fresh secret binding has not propagated, then succeeds", async () => {
    const { run, calls } = fakeGcloud({
      "run services update": [
        fail(
          "ERROR: (gcloud.run.services.update) spec.template.spec.containers[0].env[3].value_from.secret_key_ref.name: Permission denied on secret: projects/1/secrets/caelo-production-postgres-password/versions/latest for Revision service account caelo-production-gateway-sa@acme.iam.gserviceaccount.com.",
        ),
        ok(),
      ],
    });
    const slept: number[] = [];
    const r = await rollService(["run", "services", "update", "gw"], {
      run,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([10_000]);
  });

  it("returns any other failure at once", async () => {
    const { run, calls } = fakeGcloud({
      "run services update": [fail("ERROR: revision failed readiness check")],
    });
    const r = await rollService(["run", "services", "update", "gw"], {
      run,
      sleep: async () => {},
    });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("policyGrants", () => {
  it("matches unconditional bindings only", () => {
    const json = JSON.stringify({
      bindings: [
        { role: "roles/a", members: ["user:x"] },
        { role: "roles/b", members: ["user:x"], condition: { title: "t" } },
      ],
    });
    expect(policyGrants(json, "roles/a", "user:x")).toBe(true);
    expect(policyGrants(json, "roles/b", "user:x")).toBe(false);
    expect(policyGrants("{}", "roles/a", "user:x")).toBe(false);
  });
});

describe("ensureStackInvariants", () => {
  /** Policies that already hold every gcp-firebase invariant. */
  const fullFirebase = () => ({
    "projects describe": [ok("42\n")],
    "projects get-iam-policy": [
      policy([
        { role: "roles/firebasehosting.admin", members: [RUN_SA] },
        { role: "roles/logging.logWriter", members: [RUN_SA] },
        { role: "roles/monitoring.metricWriter", members: [RUN_SA] },
        ...GW_TELEMETRY,
      ]),
    ],
    "secrets get-iam-policy": [
      policy([{ role: "roles/secretmanager.secretAccessor", members: [RUN_SA, GW_SA] }]),
    ],
    "storage buckets get-iam-policy": [
      policy([{ role: "roles/storage.objectAdmin", members: [RUN_SA] }]),
    ],
    "run services get-iam-policy caelo-production-gateway-bbb": [
      policy([
        { role: "roles/run.invoker", members: ["allUsers"] },
        { role: "roles/run.viewer", members: [RUN_SA] },
      ]),
    ],
    "run services get-iam-policy caelo-production-admin-aaa": [
      policy([{ role: "roles/run.invoker", members: [IAP_AGENT] }]),
    ],
  });

  it("is a read-only no-op on an install that is already in shape", async () => {
    const { run, calls } = fakeGcloud(fullFirebase());
    const report = await ensureStackInvariants(firebase, { run, sleep: async () => {} });
    expect(report.mustAbort).toBe(false);
    expect(report.outcomes.every((o) => o.status === "present")).toBe(true);
    expect(report.outcomes).toHaveLength(stackIamInvariants("gcp-firebase").length);
    expect(calls.some((c) => c.includes("add-iam-policy-binding"))).toBe(false);
  });

  it("regression A5: adds the gateway run.viewer + telemetry roles an older install lacks", async () => {
    const answers = fullFirebase();
    answers["projects get-iam-policy"] = [
      policy([{ role: "roles/firebasehosting.admin", members: [RUN_SA] }, ...GW_TELEMETRY]),
    ];
    answers["run services get-iam-policy caelo-production-gateway-bbb"] = [
      policy([{ role: "roles/run.invoker", members: ["allUsers"] }]),
    ];
    const { run, calls } = fakeGcloud(answers);
    const report = await ensureStackInvariants(firebase, { run, sleep: async () => {} });

    expect(report.mustAbort).toBe(false);
    expect(calls).toContain(
      `run services add-iam-policy-binding caelo-production-gateway-bbb --region=europe-west1 --project=acme --member=${RUN_SA} --role=roles/run.viewer --quiet --format=none`,
    );
    for (const role of ["roles/logging.logWriter", "roles/monitoring.metricWriter"]) {
      expect(calls).toContain(
        `projects add-iam-policy-binding acme --member=${RUN_SA} --role=${role} --condition=None --quiet --format=none`,
      );
    }
    expect(report.outcomes.filter((o) => o.status === "applied")).toHaveLength(3);
    // One policy read per resource, not per invariant.
    expect(calls.filter((c) => c.startsWith("projects get-iam-policy"))).toHaveLength(1);
  });

  it("aborts when a binding the install needs can't be added", async () => {
    const answers = fullFirebase();
    answers["run services get-iam-policy caelo-production-gateway-bbb"] = [
      policy([{ role: "roles/run.invoker", members: ["allUsers"] }]),
    ];
    answers["run services add-iam-policy-binding"] = [
      fail("PERMISSION_DENIED: run.services.setIamPolicy"),
    ];
    const { run } = fakeGcloud(answers);
    const report = await ensureStackInvariants(firebase, { run, sleep: async () => {} });
    expect(report.mustAbort).toBe(true);
    const failed = report.outcomes.filter((o) => o.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toContain("roles/run.viewer");
    expect(failed[0]?.error).toContain("PERMISSION_DENIED");
  });

  it("points a binding on a resource the install predates at the installer", async () => {
    const answers = fullFirebase();
    answers["secrets get-iam-policy caelo-production-secret-kek"] = [
      fail("NOT_FOUND: Secret [caelo-production-secret-kek] not found"),
    ];
    answers["secrets add-iam-policy-binding caelo-production-secret-kek"] = [
      fail("NOT_FOUND: Secret [caelo-production-secret-kek] not found"),
    ];
    const { run } = fakeGcloud(answers);
    const report = await ensureStackInvariants(firebase, { run, sleep: async () => {} });
    expect(report.mustAbort).toBe(true);
    const failed = report.outcomes.find((o) => o.status === "failed");
    expect(failed?.error).toContain("Re-run the installer");
  });

  it("only warns when a telemetry role can't be added", async () => {
    const answers = fullFirebase();
    answers["projects get-iam-policy"] = [
      policy([{ role: "roles/firebasehosting.admin", members: [RUN_SA] }, ...GW_TELEMETRY]),
    ];
    answers["projects add-iam-policy-binding"] = [fail("PERMISSION_DENIED: setIamPolicy")];
    const { run } = fakeGcloud(answers);
    const report = await ensureStackInvariants(firebase, { run, sleep: async () => {} });
    expect(report.mustAbort).toBe(false);
    expect(report.outcomes.filter((o) => o.status === "failed")).toHaveLength(2);
  });

  it("retries a binding that loses a concurrent policy write", async () => {
    const answers = fullFirebase();
    answers["projects get-iam-policy"] = [
      policy([
        { role: "roles/firebasehosting.admin", members: [RUN_SA] },
        { role: "roles/monitoring.metricWriter", members: [RUN_SA] },
        ...GW_TELEMETRY,
      ]),
    ];
    answers["projects add-iam-policy-binding"] = [
      fail("ERROR: (gcloud.projects.add-iam-policy-binding) ABORTED: concurrent policy changes"),
      ok(),
    ];
    const { run, calls } = fakeGcloud(answers);
    const slept: number[] = [];
    const report = await ensureStackInvariants(firebase, {
      run,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(report.mustAbort).toBe(false);
    expect(calls.filter((c) => c.startsWith("projects add-iam-policy-binding"))).toHaveLength(2);
    expect(slept).toEqual([2_000]);
  });

  it("fails the IAP-agent invariants (abort) when the project number is unreadable", async () => {
    const answers = fullFirebase();
    answers["projects describe"] = [fail("PERMISSION_DENIED")];
    const { run } = fakeGcloud(answers);
    const report = await ensureStackInvariants(firebase, { run, sleep: async () => {} });
    expect(report.mustAbort).toBe(true);
    expect(report.outcomes.filter((o) => o.status === "failed")).toHaveLength(1);
  });

  describe("gcp CDN policy (regression C3)", () => {
    const fullGcp = () => ({
      "projects describe": [ok("42")],
      "projects get-iam-policy": [
        policy([
          { role: "roles/logging.logWriter", members: [RUN_SA] },
          { role: "roles/monitoring.metricWriter", members: [RUN_SA] },
          ...GW_TELEMETRY,
        ]),
      ],
      "secrets get-iam-policy": [
        policy([{ role: "roles/secretmanager.secretAccessor", members: [RUN_SA, GW_SA] }]),
      ],
      "storage buckets get-iam-policy": [
        policy([
          {
            role: "roles/storage.objectAdmin",
            members: [RUN_SA, "serviceAccount:caelo-prod-publisher@acme.iam.gserviceaccount.com"],
          },
          { role: "roles/storage.objectViewer", members: ["allUsers"] },
        ]),
      ],
      "run services get-iam-policy": [
        policy([{ role: "roles/run.invoker", members: [IAP_AGENT] }]),
      ],
      "compute backend-buckets list": [ok("caelo-production-static-backend-9f8e7d6\n")],
    });

    it("raises the pre-#555 1h/24h TTLs to a year", async () => {
      const answers = {
        ...fullGcp(),
        "compute backend-buckets describe": [
          ok(
            JSON.stringify({
              cdnPolicy: {
                cacheMode: "CACHE_ALL_STATIC",
                defaultTtl: 3600,
                maxTtl: 86400,
                clientTtl: 3600,
              },
            }),
          ),
        ],
      };
      const { run, calls } = fakeGcloud(answers);
      const report = await ensureStackInvariants(gcp, { run, sleep: async () => {} });
      expect(report.mustAbort).toBe(false);
      expect(calls).toContain(
        `compute backend-buckets update caelo-production-static-backend-9f8e7d6 --project=acme --cache-mode=CACHE_ALL_STATIC --default-ttl=3600 --max-ttl=${STATIC_CDN_POLICY.maxTtl} --client-ttl=${STATIC_CDN_POLICY.clientTtl} --quiet`,
      );
      expect(report.outcomes.find((o) => o.id.startsWith("Cloud CDN"))?.status).toBe("applied");
      // Every IAM invariant was already present.
      expect(calls.some((c) => c.includes("add-iam-policy-binding"))).toBe(false);
    });

    it("leaves a backend bucket already at the stack's policy alone", async () => {
      const answers = {
        ...fullGcp(),
        "compute backend-buckets describe": [ok(JSON.stringify({ cdnPolicy: STATIC_CDN_POLICY }))],
      };
      const { run, calls } = fakeGcloud(answers);
      const report = await ensureStackInvariants(gcp, { run, sleep: async () => {} });
      expect(calls.some((c) => c.startsWith("compute backend-buckets update"))).toBe(false);
      expect(report.outcomes.every((o) => o.status === "present")).toBe(true);
    });

    it("warns (no abort) when the CDN update fails", async () => {
      const answers = {
        ...fullGcp(),
        "compute backend-buckets describe": [ok(JSON.stringify({ cdnPolicy: {} }))],
        "compute backend-buckets update": [fail("PERMISSION_DENIED")],
      };
      const { run } = fakeGcloud(answers);
      const report = await ensureStackInvariants(gcp, { run, sleep: async () => {} });
      expect(report.mustAbort).toBe(false);
      expect(report.outcomes.find((o) => o.id.startsWith("Cloud CDN"))?.status).toBe("failed");
    });

    it("addresses buckets, secrets and the static-publisher SA by the stack's names", async () => {
      const answers = {
        ...fullGcp(),
        "storage buckets get-iam-policy": [policy([])],
        "secrets get-iam-policy": [policy([])],
        "compute backend-buckets describe": [ok(JSON.stringify({ cdnPolicy: STATIC_CDN_POLICY }))],
      };
      const { run, calls } = fakeGcloud(answers);
      await ensureStackInvariants(gcp, { run, sleep: async () => {} });
      expect(calls).toContain(
        "storage buckets add-iam-policy-binding gs://acme-caelo-production-staging --project=acme --member=" +
          `${RUN_SA} --role=roles/storage.objectAdmin --quiet --format=none`,
      );
      expect(calls).toContain(
        "storage buckets add-iam-policy-binding gs://acme-caelo-production-static --project=acme --member=allUsers --role=roles/storage.objectViewer --quiet --format=none",
      );
      expect(calls).toContain(
        `secrets add-iam-policy-binding caelo-production-secret-kek --project=acme --member=${RUN_SA} --role=roles/secretmanager.secretAccessor --quiet --format=none`,
      );
    });

    it("grants the gateway SA the database password and nothing admin-only", async () => {
      const answers = {
        ...fullGcp(),
        "secrets get-iam-policy": [policy([])],
        "compute backend-buckets describe": [ok(JSON.stringify({ cdnPolicy: STATIC_CDN_POLICY }))],
      };
      const { run, calls } = fakeGcloud(answers);
      await ensureStackInvariants(gcp, { run, sleep: async () => {} });
      const gatewayGrants = calls.filter(
        (c) => c.startsWith("secrets add-iam-policy-binding") && c.includes(GW_SA),
      );
      expect(gatewayGrants).toEqual([
        `secrets add-iam-policy-binding caelo-production-postgres-password --project=acme --member=${GW_SA} --role=roles/secretmanager.secretAccessor --quiet --format=none`,
      ]);
      for (const secret of ["internal-secret", "tool-approval-secret", "secret-kek"]) {
        expect(calls).toContain(
          `secrets add-iam-policy-binding caelo-production-${secret} --project=acme --member=${RUN_SA} --role=roles/secretmanager.secretAccessor --quiet --format=none`,
        );
      }
    });
  });
});
