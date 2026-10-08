// SPDX-License-Identifier: MPL-2.0

/**
 * The stacks must give the admin's run SA no IAM-policy rights for operator
 * access: the sync job (operator-access.ts, CLI-owned) is the only principal
 * allowed to change who passes IAP. What the stacks DO carry for it: the
 * Cloud SQL flag that lets the job log in as its service account, and the
 * admin env var naming the job (stack-contract.ts). Pure-string checks, like
 * mcp-iap-stacks.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adminEnvContract, databaseUrls } from "./stack-contract.js";

const stack = (provider: string) =>
  readFileSync(resolve(import.meta.dir, `../stacks/${provider}/index.ts`), "utf8");

describe.each(["gcp", "gcp-firebase"])("%s stack — operator access", (provider) => {
  const src = stack(provider);

  it("grants no IAM-policy-writing role to anyone for operator access", () => {
    expect(src).not.toContain("caeloOperatorAccess");
    expect(src).not.toContain("caeloAdminIapLookup");
    expect(src).not.toContain("IAMCustomRole");
    expect(src).not.toMatch(/setIamPolicy|roles\/iap\.admin|roles\/iam\.serviceAccountAdmin/);
  });

  it("turns on Cloud SQL IAM database authentication for the job's read-only user", () => {
    expect(src).toContain('{ name: "cloudsql.iam_authentication", value: "on" }');
  });

  it("deploys the admin with the env contract, which names the sync job", () => {
    expect(src).toContain("adminEnvContract(");
  });
});

describe("admin env contract — operator access", () => {
  it("names the sync job the admin may start", () => {
    const env = adminEnvContract({
      provider: "gcp",
      projectId: "acme",
      env: "production",
      domain: "acme.com",
      region: "europe-west1",
      databaseUrls: databaseUrls("10.0.0.3"),
    });
    expect(env).toContainEqual({
      name: "CAELO_OPERATOR_ACCESS_JOB",
      value: "projects/acme/locations/europe-west1/jobs/caelo-production-operator-access-sync",
    });
  });
});
