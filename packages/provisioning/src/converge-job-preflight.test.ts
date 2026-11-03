// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job's IAM self-check list (#884): a provisioner holding what
 * the install and converge-job-setup.ts grant passes it, each role the setup
 * grants on top is checked, and losing one is named with what it is for.
 */

import { describe, expect, it } from "bun:test";
import { selfGrantArgs } from "./converge-job-gcp.js";
import {
  CONVERGE_PREFLIGHT_VOICE,
  CONVERGE_SELF_GRANTABLE_ROLES,
  convergeAccessChecks,
  INSTALL_ROLE_USES,
  isSelfGrantableRole,
  SELF_GRANT_FORBIDDEN_ROLES,
  selfGrantPlan,
} from "./converge-job-preflight.js";
import { PROVISIONER_ROLE_LIST } from "./gcloud.js";
import { INSTALL_JOB_ROLES } from "./install-job.js";
import {
  type IamTester,
  preflightMissingReason,
  resourceName,
  runIamPreflight,
} from "./upgrader-iam-preflight.js";

const TARGET = { projectId: "acme", region: "europe-west1", env: "production" };

/**
 * The permissions of the predefined roles the provisioner holds, as far as
 * the self-check asks for them (cloud.google.com/iam/docs/understanding-roles).
 */
const PREDEFINED: Record<string, readonly string[]> = {
  "roles/run.admin": ["run.jobs.get", "run.jobs.update", "run.jobs.run", "run.executions.get"],
  "roles/cloudsql.admin": ["cloudsql.instances.get", "cloudsql.instances.login"],
  "roles/storage.admin": [
    "storage.objects.list",
    "storage.objects.get",
    "storage.objects.create",
    "storage.objects.delete",
  ],
  "roles/iam.serviceAccountUser": ["iam.serviceAccounts.actAs"],
  "roles/iam.roleAdmin": ["iam.roles.create", "iam.roles.get", "iam.roles.update"],
  "roles/cloudscheduler.admin": [
    "cloudscheduler.jobs.create",
    "cloudscheduler.jobs.get",
    "cloudscheduler.jobs.update",
  ],
  "roles/workflows.editor": [
    "workflows.workflows.create",
    "workflows.workflows.get",
    "workflows.workflows.update",
  ],
  "roles/logging.logWriter": ["logging.logEntries.create"],
};

/**
 * A tester for a provisioner holding `roles` project-wide: unconditional
 * project roles reach every resource of the project, so each answers alike.
 */
function provisioner(roles: readonly string[]): IamTester {
  const held = new Set(roles.flatMap((r) => PREDEFINED[r] ?? []));
  return {
    granted: async (_resource, permissions) => ({
      ok: true,
      granted: permissions.filter((p) => held.has(p)),
    }),
  };
}

describe("convergeAccessChecks", () => {
  it("a provisioner with its install roles and the converge setup's roles passes", async () => {
    const r = await runIamPreflight(
      convergeAccessChecks(TARGET),
      provisioner([...PROVISIONER_ROLE_LIST, ...INSTALL_JOB_ROLES]),
    );
    expect(r).toEqual({ kind: "ok" });
  });

  it("checks every role converge-job-setup.ts grants the provisioner", () => {
    const checks = convergeAccessChecks(TARGET);
    for (const role of INSTALL_JOB_ROLES) {
      expect(checks).toContainEqual({
        resource: { kind: "project", projectId: "acme" },
        role,
        ...INSTALL_ROLE_USES[role],
      });
    }
  });

  it("asks about the converge job, the ops bucket and the provisioner's own account", () => {
    const where = new Set(convergeAccessChecks(TARGET).map((c) => resourceName(c.resource)));
    expect(where).toEqual(
      new Set([
        "projects/acme",
        "gs://acme-caelo-ops",
        "projects/acme/locations/europe-west1/jobs/caelo-production-converge",
        "projects/acme/serviceAccounts/caelo-provisioner@acme.iam.gserviceaccount.com",
      ]),
    );
  });

  it("a provisioner without the install-job roles is stopped, each named with what it is for", async () => {
    const r = await runIamPreflight(
      convergeAccessChecks(TARGET),
      provisioner(PROVISIONER_ROLE_LIST),
    );
    expect(r.kind).toBe("missing");
    if (r.kind !== "missing") return;
    expect(r.missing.flatMap((m) => m.missing).sort()).toEqual(
      INSTALL_JOB_ROLES.flatMap((role) => INSTALL_ROLE_USES[role].permissions).sort(),
    );
    const reason = preflightMissingReason(r.missing, CONVERGE_PREFLIGHT_VOICE);
    expect(reason).toContain("keeps the admin's access list in sync");
    expect(reason).toContain("Cloud Shell or the computer you installed from");
  });
});

describe("the converge job's self-grant allowlist (2026-11-03)", () => {
  it("is exactly the roles converge-job-setup.ts grants the provisioner", () => {
    expect([...CONVERGE_SELF_GRANTABLE_ROLES]).toEqual([...INSTALL_JOB_ROLES]);
    expect(CONVERGE_SELF_GRANTABLE_ROLES).toContain("roles/workflows.editor");
  });

  it("names no ownership or IAM-policy role", () => {
    for (const role of CONVERGE_SELF_GRANTABLE_ROLES) {
      for (const f of SELF_GRANT_FORBIDDEN_ROLES) {
        expect(role === f || (f.endsWith(".") && role.startsWith(f))).toBe(false);
      }
    }
  });

  it("refuses every role outside the list, escalations first", () => {
    for (const role of [
      "roles/owner",
      "roles/editor",
      "roles/resourcemanager.projectIamAdmin",
      "roles/iam.securityAdmin",
      "roles/iam.serviceAccountKeyAdmin",
      "roles/run.admin",
      "roles/workflows.admin",
      "roles/workflows.editor ",
      "",
    ]) {
      expect(isSelfGrantableRole(role)).toBe(false);
    }
    for (const role of INSTALL_JOB_ROLES) expect(isSelfGrantableRole(role)).toBe(true);
  });

  it("the grant names the project and the provisioner only, and refuses other roles", () => {
    expect(selfGrantArgs("acme", "roles/workflows.editor")).toEqual([
      "projects",
      "add-iam-policy-binding",
      "acme",
      "--member=serviceAccount:caelo-provisioner@acme.iam.gserviceaccount.com",
      "--role=roles/workflows.editor",
      "--condition=None",
      "--quiet",
      "--format=none",
    ]);
    for (const role of [
      "roles/owner",
      "roles/resourcemanager.projectIamAdmin",
      "roles/run.admin",
    ]) {
      expect(selfGrantArgs("acme", role)).toBeNull();
    }
  });
});

describe("selfGrantPlan", () => {
  it("an install from before 0.11.11 (no workflows.editor) needs one grant and nothing blocks", async () => {
    const r = await runIamPreflight(
      convergeAccessChecks(TARGET),
      provisioner([
        ...PROVISIONER_ROLE_LIST,
        ...INSTALL_JOB_ROLES.filter((role) => role !== "roles/workflows.editor"),
      ]),
    );
    expect(r.kind).toBe("missing");
    if (r.kind !== "missing") return;
    expect(selfGrantPlan(r.missing)).toEqual({ grant: ["roles/workflows.editor"], blocking: [] });
  });

  it("every install-job role missing: all of them, in list order", async () => {
    const r = await runIamPreflight(
      convergeAccessChecks(TARGET),
      provisioner(PROVISIONER_ROLE_LIST),
    );
    if (r.kind !== "missing") throw new Error("expected missing");
    const plan = selfGrantPlan([...r.missing].reverse());
    expect(plan.grant).toEqual([...INSTALL_JOB_ROLES]);
    expect(plan.blocking).toEqual([]);
  });

  it("a check without a role, or with a role off the list, blocks", () => {
    const actAs = convergeAccessChecks(TARGET).find((c) =>
      c.permissions.includes("iam.serviceAccounts.actAs"),
    );
    if (!actAs) throw new Error("no actAs check");
    const forged = {
      ...actAs,
      role: "roles/owner" as unknown as (typeof INSTALL_JOB_ROLES)[number],
    };
    const plan = selfGrantPlan([
      { check: actAs, missing: ["iam.serviceAccounts.actAs"] },
      { check: forged, missing: ["iam.serviceAccounts.actAs"] },
    ]);
    expect(plan.grant).toEqual([]);
    expect(plan.blocking).toHaveLength(2);
  });
});
