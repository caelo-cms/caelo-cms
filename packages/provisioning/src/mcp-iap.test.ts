// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { mcpIapServiceAccountEmail } from "./gcp-names.js";
import { ensureMcpIapAccess, iapOperators } from "./mcp-iap.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const POLICY = JSON.stringify({
  bindings: [
    {
      role: "roles/iap.httpsResourceAccessor",
      members: [
        "user:owner@example.com",
        "group:editors@example.com",
        "serviceAccount:caelo-mcp@p.iam.gserviceaccount.com",
      ],
    },
    { role: "roles/iap.admin", members: ["user:admin@example.com"] },
  ],
});

/** Fake gcloud answering by command prefix; records every call. */
function fakeGcloud(answers: Record<string, GcloudResult[]>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]?.shift()) || ok();
  };
  return { run, calls };
}

const cloudRun = {
  kind: "cloud-run",
  service: "caelo-production-admin-abc",
  region: "europe-west1",
} as const;

describe("iapOperators", () => {
  it("takes users and groups with IAP access, not service accounts or other roles", () => {
    expect(iapOperators(POLICY)).toEqual(["user:owner@example.com", "group:editors@example.com"]);
  });

  it("ignores conditional bindings and empty policies", () => {
    expect(
      iapOperators(
        JSON.stringify({
          bindings: [
            {
              role: "roles/iap.httpsResourceAccessor",
              members: ["user:x@y"],
              condition: { title: "t" },
            },
          ],
        }),
      ),
    ).toEqual([]);
    expect(iapOperators("{}")).toEqual([]);
  });
});

/** The IAP policy before the MCP account existed: operators only. */
const OPERATORS_ONLY = JSON.stringify({
  bindings: [
    {
      role: "roles/iap.httpsResourceAccessor",
      members: ["user:owner@example.com", "group:editors@example.com"],
    },
  ],
});

/** The MCP account's own policy once every operator may sign as it. */
const SIGNERS = JSON.stringify({
  bindings: [
    {
      role: "roles/iam.serviceAccountTokenCreator",
      members: ["user:owner@example.com", "group:editors@example.com"],
    },
  ],
});

describe("ensureMcpIapAccess", () => {
  it("creates the SA, allowlists it on IAP and lets every IAP operator sign as it", async () => {
    const { run, calls } = fakeGcloud({
      "iam service-accounts describe": [fail("NOT_FOUND")],
      "iap web get-iam-policy": [ok(OPERATORS_ONLY)],
    });
    const r = await ensureMcpIapAccess({
      projectId: "p",
      resource: cloudRun,
      run,
      sleep: async () => {},
    });

    expect(r).toEqual({
      ok: true,
      serviceAccount: mcpIapServiceAccountEmail("p"),
      operators: ["user:owner@example.com", "group:editors@example.com"],
      granted: [
        "roles/iap.httpsResourceAccessor → serviceAccount:caelo-mcp@p.iam.gserviceaccount.com",
        "roles/iam.serviceAccountTokenCreator → user:owner@example.com",
        "roles/iam.serviceAccountTokenCreator → group:editors@example.com",
      ],
    });
    const lines = calls.map((c) => c.join(" "));
    expect(lines.some((l) => l.startsWith("iam service-accounts create caelo-mcp"))).toBe(true);
    expect(lines).toContainEqual(
      "iap web add-iam-policy-binding --resource-type=cloud-run --service=caelo-production-admin-abc --region=europe-west1 --member=serviceAccount:caelo-mcp@p.iam.gserviceaccount.com --role=roles/iap.httpsResourceAccessor --condition=None --project=p --quiet",
    );
    for (const m of ["user:owner@example.com", "group:editors@example.com"]) {
      expect(lines).toContainEqual(
        `iam service-accounts add-iam-policy-binding caelo-mcp@p.iam.gserviceaccount.com --member=${m} --role=roles/iam.serviceAccountTokenCreator --condition=None --project=p --quiet`,
      );
    }
  });

  it("is a no-op re-run when everything is in place: no create, no binding written, nothing granted", async () => {
    const { run, calls } = fakeGcloud({
      "iap web get-iam-policy": [ok(POLICY)],
      "iam service-accounts get-iam-policy": [ok(SIGNERS)],
    });
    const r = await ensureMcpIapAccess({ projectId: "p", resource: cloudRun, run });
    expect(r.ok && r.granted).toEqual([]);
    expect(calls.some((c) => c.join(" ").startsWith("iam service-accounts create"))).toBe(false);
    expect(calls.some((c) => c.includes("add-iam-policy-binding"))).toBe(false);
  });

  it("#734 — names only the grant this run added (a new operator on the allowlist)", async () => {
    const { run, calls } = fakeGcloud({
      "iap web get-iam-policy": [ok(POLICY)],
      "iam service-accounts get-iam-policy": [
        ok(
          JSON.stringify({
            bindings: [
              {
                role: "roles/iam.serviceAccountTokenCreator",
                members: ["user:owner@example.com"],
              },
            ],
          }),
        ),
      ],
    });
    const r = await ensureMcpIapAccess({ projectId: "p", resource: cloudRun, run });
    expect(r.ok && r.granted).toEqual([
      "roles/iam.serviceAccountTokenCreator → group:editors@example.com",
    ]);
    expect(calls.filter((c) => c.includes("add-iam-policy-binding"))).toHaveLength(1);
  });

  it("writes every binding when the account's policy can't be read (and counts them as granted)", async () => {
    const { run } = fakeGcloud({
      "iap web get-iam-policy": [ok(POLICY)],
      "iam service-accounts get-iam-policy": [fail("PERMISSION_DENIED")],
    });
    const r = await ensureMcpIapAccess({ projectId: "p", resource: cloudRun, run });
    expect(r.ok && r.granted).toHaveLength(2);
  });

  it("addresses the LB backend service on the gcp provider", async () => {
    const { run, calls } = fakeGcloud({ "iap web get-iam-policy": [ok(POLICY)] });
    await ensureMcpIapAccess({
      projectId: "p",
      resource: { kind: "backend-services", service: "caelo-production-admin-backend-1a2b" },
      run,
    });
    const iapCalls = calls.filter((c) => c[0] === "iap");
    for (const c of iapCalls) {
      expect(c).toContain("--resource-type=backend-services");
      expect(c).toContain("--service=caelo-production-admin-backend-1a2b");
      expect(c.some((a) => a.startsWith("--region"))).toBe(false);
    }
  });

  it("retries bindings while a new SA propagates", async () => {
    const { run, calls } = fakeGcloud({
      "iam service-accounts describe": [fail("NOT_FOUND")],
      "iap web get-iam-policy": [ok(OPERATORS_ONLY)],
      "iap web add-iam-policy-binding": [fail("Service account caelo-mcp@p does not exist.")],
    });
    const slept: number[] = [];
    const r = await ensureMcpIapAccess({
      projectId: "p",
      resource: cloudRun,
      run,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(r.ok).toBe(true);
    expect(
      calls.filter((c) => c.join(" ").startsWith("iap web add-iam-policy-binding")),
    ).toHaveLength(2);
    expect(slept).toEqual([2_000]);
  });

  it("reports a failure instead of half-configuring silently", async () => {
    const { run } = fakeGcloud({
      "iap web get-iam-policy": [fail("PERMISSION_DENIED: iap.web.getIamPolicy")],
    });
    const r = await ensureMcpIapAccess({ projectId: "p", resource: cloudRun, run });
    expect(r).toEqual({
      ok: false,
      error: "read IAP policy: PERMISSION_DENIED: iap.web.getIamPolicy",
    });
  });
});
