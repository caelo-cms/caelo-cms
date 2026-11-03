// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import type { HttpFetch } from "./runtime-secrets.js";
import { ensureStagingDatabase } from "./staging-database.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const noSleep = async () => {};
const install = { projectId: "acme", env: "production", credentials: "operator" } as const;

/** gcloud with an instance `pg-1`, the databases and users given, and a staging password secret. */
function fakeGcloud(state: { databases: string[]; users: string[] }) {
  const calls: string[] = [];
  const run: GcloudRunner = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.startsWith("sql instances list")) return ok("pg-1\n");
    if (line.startsWith("sql databases list")) return ok(`${state.databases.join("\n")}\n`);
    if (line.startsWith("sql users list")) return ok(`${state.users.join("\n")}\n`);
    if (line.startsWith("sql databases create")) return ok();
    if (line.startsWith("secrets versions access latest")) return ok("s3cret-staging");
    if (line.startsWith("auth print-access-token")) return ok("tok\n");
    return fail(`unexpected: ${line}`);
  };
  return { run, calls };
}

/** The Cloud SQL Admin API, finishing every operation at once. */
function fakeHttp() {
  const requests: { method: string; url: string; body?: string }[] = [];
  const http: HttpFetch = async (url, init) => {
    requests.push({ method: init.method, url, ...(init.body ? { body: init.body } : {}) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "DONE" }) };
  };
  return { http, requests };
}

describe("ensureStagingDatabase (#1329)", () => {
  it("creates the database and the login on an install from before them", async () => {
    const { run, calls } = fakeGcloud({
      databases: ["cms_admin", "cms_public"],
      users: ["admin_role", "public_role"],
    });
    const { http, requests } = fakeHttp();
    const outcomes = await ensureStagingDatabase(install, { run, http, sleep: noSleep });
    expect(outcomes.map((o) => [o.id, o.status])).toEqual([
      ["database cms_public_staging", "applied"],
      ["database role public_staging_role", "applied"],
    ]);
    expect(calls).toContain(
      "sql databases create cms_public_staging --instance=pg-1 --project=acme --quiet",
    );
    // The password goes in the request body, read from its own secret.
    expect(calls).toContain(
      "secrets versions access latest --secret=caelo-production-public-staging-role-password --project=acme",
    );
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://sqladmin.googleapis.com/v1/projects/acme/instances/pg-1/users",
        body: JSON.stringify({ name: "public_staging_role", password: "s3cret-staging" }),
      },
    ]);
    expect(calls.some((c) => c.includes("s3cret-staging"))).toBe(false);
  });

  it("leaves an install that has both alone, re-applying the password", async () => {
    const { run, calls } = fakeGcloud({
      databases: ["cms_admin", "cms_public", "cms_public_staging"],
      users: ["admin_role", "public_role", "public_staging_role"],
    });
    const { http, requests } = fakeHttp();
    const outcomes = await ensureStagingDatabase(install, { run, http, sleep: noSleep });
    expect(outcomes.map((o) => o.status)).toEqual(["present", "present"]);
    expect(calls.some((c) => c.startsWith("sql databases create"))).toBe(false);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      [
        "PUT",
        "https://sqladmin.googleapis.com/v1/projects/acme/instances/pg-1/users?name=public_staging_role",
      ],
    ]);
  });

  it("reports a refused create with the permission it needs", async () => {
    const calls: string[] = [];
    const run: GcloudRunner = async (args) => {
      const line = args.join(" ");
      calls.push(line);
      if (line.startsWith("sql instances list")) return ok("pg-1\n");
      if (line.startsWith("sql databases list")) return ok("cms_admin\n");
      if (line.startsWith("sql databases create")) return fail("PERMISSION_DENIED: nope");
      return ok("public_staging_role\n");
    };
    const { http } = fakeHttp();
    const [db] = await ensureStagingDatabase(install, { run, http, sleep: noSleep });
    expect(db?.status).toBe("failed");
    expect(db?.error).toContain("cloudsql.databases.create");
  });

  it("fails without an instance and creates nothing", async () => {
    const calls: string[] = [];
    const run: GcloudRunner = async (args) => {
      calls.push(args.join(" "));
      return ok("");
    };
    const outcomes = await ensureStagingDatabase(install, { run, sleep: noSleep });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("failed");
    expect(calls).toHaveLength(1);
  });
});
