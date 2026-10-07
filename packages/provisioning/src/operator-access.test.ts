// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { ensureOperatorAccessGrants } from "./operator-access.js";
import {
  ADMIN_IAP_LOOKUP_ROLE,
  ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS,
  OPERATOR_ACCESS_ROLE,
} from "./operator-access-grants.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

function fakeGcloud(answers: Record<string, GcloudResult[]>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]?.shift()) || ok();
  };
  return { run, calls };
}

const ADMIN_SA = "caelo-production-run@p.iam.gserviceaccount.com";
const cloudRun = {
  kind: "cloud-run",
  service: "caelo-production-admin-abc",
  region: "europe-west1",
} as const;
const backend = { kind: "backend-services", service: "caelo-production-admin-backend-x" } as const;

describe("operator-access grants list", () => {
  it("only ever asks for get/setIamPolicy on the two resources, plus backend lookup on gcp", () => {
    expect([...OPERATOR_ACCESS_ROLE.permissions].sort()).toEqual([
      "iam.serviceAccounts.getIamPolicy",
      "iam.serviceAccounts.setIamPolicy",
      "iap.webServices.getIamPolicy",
      "iap.webServices.setIamPolicy",
    ]);
    expect(ADMIN_IAP_LOOKUP_ROLE.permissions).toEqual(["compute.backendServices.list"]);
    const projectWide = ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS.filter((g) => g.scope === "project");
    expect(projectWide.map((g) => g.role)).toEqual([ADMIN_IAP_LOOKUP_ROLE]);
    expect(projectWide[0]?.providers).toEqual(["gcp"]);
  });
});

describe("ensureOperatorAccessGrants", () => {
  it("gcp-firebase: creates the role and binds it on the Cloud Run IAP resource and the MCP SA", async () => {
    const { run, calls } = fakeGcloud({ "iam roles describe": [fail("NOT_FOUND")] });
    const r = await ensureOperatorAccessGrants({
      projectId: "p",
      provider: "gcp-firebase",
      resource: cloudRun,
      adminServiceAccount: ADMIN_SA,
      run,
    });
    expect(r).toEqual({
      ok: true,
      granted: [
        "caeloOperatorAccess on admin-iap-resource",
        "caeloOperatorAccess on mcp-service-account",
      ],
    });
    const lines = calls.map((c) => c.join(" "));
    expect(
      lines.some((l) => l.startsWith("iam roles create caeloOperatorAccess --project=p")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("caeloAdminIapLookup"))).toBe(false);
    const role = "--role=projects/p/roles/caeloOperatorAccess";
    expect(calls).toContainEqual([
      "iap",
      "web",
      "add-iam-policy-binding",
      "--resource-type=cloud-run",
      "--service=caelo-production-admin-abc",
      "--region=europe-west1",
      `--member=serviceAccount:${ADMIN_SA}`,
      role,
      "--condition=None",
      "--project=p",
      "--quiet",
    ]);
    expect(calls).toContainEqual([
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      "caelo-mcp@p.iam.gserviceaccount.com",
      `--member=serviceAccount:${ADMIN_SA}`,
      role,
      "--condition=None",
      "--project=p",
      "--quiet",
    ]);
  });

  it("gcp: also binds the backend-lookup role at project level, nothing else project-wide", async () => {
    const { run, calls } = fakeGcloud({
      "iam roles describe": [fail("NOT_FOUND"), fail("NOT_FOUND")],
    });
    const r = await ensureOperatorAccessGrants({
      projectId: "p",
      provider: "gcp",
      resource: backend,
      adminServiceAccount: ADMIN_SA,
      run,
    });
    expect(r.ok).toBe(true);
    const projectBindings = calls.filter((c) => c[0] === "projects");
    expect(projectBindings).toEqual([
      [
        "projects",
        "add-iam-policy-binding",
        "p",
        `--member=serviceAccount:${ADMIN_SA}`,
        "--role=projects/p/roles/caeloAdminIapLookup",
        "--condition=None",
        "--project=p",
        "--quiet",
      ],
    ]);
    expect(
      calls.some(
        (c) =>
          c.includes("--resource-type=backend-services") &&
          c.includes(`--service=${backend.service}`),
      ),
    ).toBe(true);
  });

  it("re-running on an up-to-date install creates nothing", async () => {
    const current = JSON.stringify({ includedPermissions: [...OPERATOR_ACCESS_ROLE.permissions] });
    const { run, calls } = fakeGcloud({ "iam roles describe": [ok(current)] });
    await ensureOperatorAccessGrants({
      projectId: "p",
      provider: "gcp-firebase",
      resource: cloudRun,
      adminServiceAccount: ADMIN_SA,
      run,
    });
    expect(calls.some((c) => c[2] === "create" || c[2] === "update" || c[2] === "undelete")).toBe(
      false,
    );
  });

  it("undeletes a soft-deleted role and brings its permissions back to spec", async () => {
    const deleted = JSON.stringify({
      deleted: true,
      includedPermissions: ["iap.webServices.getIamPolicy"],
    });
    const { run, calls } = fakeGcloud({ "iam roles describe": [ok(deleted)] });
    const r = await ensureOperatorAccessGrants({
      projectId: "p",
      provider: "gcp-firebase",
      resource: cloudRun,
      adminServiceAccount: ADMIN_SA,
      run,
    });
    expect(r.ok).toBe(true);
    const verbs = calls.filter((c) => c[0] === "iam" && c[1] === "roles").map((c) => c[2]);
    expect(verbs).toEqual(["describe", "undelete", "update"]);
  });

  it("reports which grant failed instead of carrying on", async () => {
    const { run } = fakeGcloud({
      "iam roles describe": [fail("NOT_FOUND")],
      "iap web add-iam-policy-binding": [
        fail("PERMISSION_DENIED: caller lacks iap.webServices.setIamPolicy"),
      ],
    });
    const r = await ensureOperatorAccessGrants({
      projectId: "p",
      provider: "gcp-firebase",
      resource: cloudRun,
      adminServiceAccount: ADMIN_SA,
      run,
    });
    expect(r).toEqual({
      ok: false,
      error:
        "caeloOperatorAccess on admin-iap-resource: PERMISSION_DENIED: caller lacks iap.webServices.setIamPolicy",
    });
  });
});
