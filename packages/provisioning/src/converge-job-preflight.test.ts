// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job's IAM self-check list (#884): a provisioner holding what
 * the install and converge-job-setup.ts grant passes it, each role the setup
 * grants on top is checked, and losing one is named with what it is for.
 */

import { describe, expect, it } from "bun:test";
import {
  CONVERGE_PREFLIGHT_VOICE,
  convergeAccessChecks,
  INSTALL_ROLE_USES,
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
