// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { enableAdminDomain } from "./admin-domain.js";
import type { GcloudResult } from "./gcloud.js";

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

const MAPPING = JSON.stringify({
  status: { resourceRecords: [{ name: "admin", type: "CNAME", rrdata: "ghs.googlehosted.com." }] },
});
const base = { projectId: "p", region: "europe-west1", domain: "example.com" };

describe("enableAdminDomain", () => {
  it("creates the mapping as the operator once the domain is verified, and prints the record", async () => {
    const { run, calls } = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "beta run domain-mappings describe": [fail("NOT_FOUND"), ok(MAPPING)],
      "domains list-user-verified": [ok("example.com\n")],
    });
    const r = await enableAdminDomain({ ...base, run });
    expect(r).toEqual({
      status: "mapped",
      hostname: "admin.example.com",
      created: true,
      records: [{ name: "admin.example.com", type: "CNAME", value: "ghs.googlehosted.com." }],
    });
    expect(calls).toContainEqual([
      "beta",
      "run",
      "domain-mappings",
      "create",
      "--service=caelo-production-admin-abc",
      "--domain=admin.example.com",
      "--region=europe-west1",
      "--project=p",
      "--quiet",
    ]);
  });

  it("is idempotent: an existing mapping is reported, not recreated", async () => {
    const { run, calls } = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "beta run domain-mappings describe": [ok(MAPPING)],
    });
    const r = await enableAdminDomain({ ...base, run });
    expect(r.status === "mapped" && !r.created).toBe(true);
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("starts Search Console verification and stops when the operator has not verified the domain", async () => {
    const { run, calls } = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "beta run domain-mappings describe": [fail("NOT_FOUND")],
      "domains list-user-verified": [ok("other.org\n")],
    });
    const r = await enableAdminDomain({ ...base, run });
    expect(r).toEqual({
      status: "needs-verification",
      hostname: "admin.example.com",
      verifyDomain: "example.com",
    });
    expect(calls).toContainEqual(["domains", "verify", "example.com"]);
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("fails loudly when the admin service cannot be found or the create is refused", async () => {
    const missing = fakeGcloud({ "run services list": [ok("")] });
    expect((await enableAdminDomain({ ...base, run: missing.run })).status).toBe("failed");

    const refused = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "beta run domain-mappings describe": [fail("NOT_FOUND")],
      "domains list-user-verified": [ok("admin.example.com\n")],
      "beta run domain-mappings create": [
        fail("Caller is not authorized to administer the domain"),
      ],
    });
    expect(await enableAdminDomain({ ...base, run: refused.run })).toEqual({
      status: "failed",
      error: "create domain mapping: Caller is not authorized to administer the domain",
    });
  });
});
