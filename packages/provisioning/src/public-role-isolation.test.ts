// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  revokePublicRoleMemberships,
  revokePublicRoleMembershipsArgs,
} from "./public-role-isolation.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const noSleep = async () => {};

function fake(answers: (line: string) => GcloudResult) {
  const calls: string[] = [];
  const run: GcloudRunner = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    return answers(line);
  };
  return { run, calls };
}

describe("revokePublicRoleMembershipsArgs (#633)", () => {
  it("revokes every database role of the built-in public_role user", () => {
    expect(
      revokePublicRoleMembershipsArgs({ projectId: "acme", sqlInstance: "caelo-production-pg-1" }),
    ).toEqual([
      "sql",
      "users",
      "assign-roles",
      "public_role",
      "--instance=caelo-production-pg-1",
      "--type=BUILT_IN",
      "--revoke-existing-roles",
      "--project=acme",
      "--quiet",
    ]);
  });

  it("grants nothing in exchange (no --database-roles)", () => {
    const args = revokePublicRoleMembershipsArgs({ projectId: "p", sqlInstance: "i" });
    expect(args.some((a) => a.startsWith("--database-roles"))).toBe(false);
  });
});

describe("revokePublicRoleMemberships", () => {
  const install = { projectId: "acme", env: "production" };

  it("finds the instance, then revokes", async () => {
    const { run, calls } = fake((l) => (l.startsWith("sql instances list") ? ok("pg-1\n") : ok()));
    const r = await revokePublicRoleMemberships(install, { run, sleep: noSleep });
    expect(r).toEqual({
      id: "public_role database role memberships",
      status: "applied",
      detail: "no database roles left on pg-1",
    });
    expect(calls[1]).toBe(
      "sql users assign-roles public_role --instance=pg-1 --type=BUILT_IN --revoke-existing-roles --project=acme --quiet",
    );
  });

  it("is idempotent: a second run issues the same revoke and succeeds", async () => {
    const { run, calls } = fake((l) => (l.startsWith("sql instances list") ? ok("pg-1\n") : ok()));
    await revokePublicRoleMemberships(install, { run, sleep: noSleep });
    const again = await revokePublicRoleMemberships(install, { run, sleep: noSleep });
    expect(again.status).toBe("applied");
    expect(calls[1]).toBe(calls[3] as string);
  });

  it("fails without an instance and never calls the revoke", async () => {
    const { run, calls } = fake(() => ok(""));
    const r = await revokePublicRoleMemberships(install, { run, sleep: noSleep });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("the Cloud SQL instance was not found");
    expect(calls).toHaveLength(1);
  });

  it("reports a refused revoke with the permission it needs", async () => {
    const { run } = fake((l) =>
      l.startsWith("sql instances list") ? ok("pg-1\n") : fail("PERMISSION_DENIED: nope"),
    );
    const r = await revokePublicRoleMemberships(install, { run, sleep: noSleep });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("PERMISSION_DENIED: nope");
    expect(r.error).toContain("cloudsql.users.update");
  });
});
