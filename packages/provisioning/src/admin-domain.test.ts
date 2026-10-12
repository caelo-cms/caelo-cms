// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { enableAdminDomain } from "./admin-domain.js";
import type { GcloudResult } from "./gcloud.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** Fake gcloud; the `beta` component is installed unless a test answers `components list`. */
function fakeGcloud(overrides: Record<string, GcloudResult[]>) {
  const answers: Record<string, GcloudResult[]> = {
    "components list": [ok("beta\n")],
    ...overrides,
  };
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
const base = { projectId: "p", region: "europe-west1", domain: "example.com", log: () => {} };

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

  it("refuses to pick when more than one admin service matches", async () => {
    const { run, calls } = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\ncaelo-production-admin-old\n")],
    });
    const r = await enableAdminDomain({ ...base, run });
    expect(r.status === "failed" && r.error).toContain("exactly one");
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("fails (not needs-verification) when gcloud cannot list or start verification", async () => {
    const listFails = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "beta run domain-mappings describe": [fail("NOT_FOUND")],
      "domains list-user-verified": [fail("Reauthentication required")],
    });
    expect(await enableAdminDomain({ ...base, run: listFails.run })).toEqual({
      status: "failed",
      error: "list verified domains: Reauthentication required",
    });

    const verifyFails = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "beta run domain-mappings describe": [fail("NOT_FOUND")],
      "domains list-user-verified": [ok("other.org\n")],
      "domains verify": [fail("could not open a browser")],
    });
    expect(await enableAdminDomain({ ...base, run: verifyFails.run })).toEqual({
      status: "failed",
      error: "start domain verification for example.com: could not open a browser",
    });
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

  it("installs the missing beta component before the first beta command (regression: hidden gcloud prompt hung the CLI)", async () => {
    const logs: string[] = [];
    const { run, calls } = fakeGcloud({
      "components list": [ok("")],
      "run services list": [ok("caelo-production-admin-abc\n")],
      "beta run domain-mappings describe": [ok(MAPPING)],
    });
    const r = await enableAdminDomain({ ...base, run, log: (m) => logs.push(m) });
    expect(r.status).toBe("mapped");
    const install = calls.findIndex((c) => c.join(" ") === "components install beta --quiet");
    const firstBeta = calls.findIndex((c) => c[0] === "beta");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(firstBeta);
    expect(logs.join("\n")).toContain('Installing the gcloud "beta" component');
  });

  it("fails with the package-manager command when gcloud cannot install the beta component", async () => {
    const { run, calls } = fakeGcloud({
      "components list": [ok("")],
      "run services list": [ok("caelo-production-admin-abc\n")],
      "components install": [
        fail(
          "ERROR: (gcloud.components.install)\nYou cannot perform this action because the Google Cloud CLI component manager \nis disabled for this installation. You can run the following command \nto achieve the same result for this installation: \n\nsudo apt-get install google-cloud-cli",
        ),
      ],
    });
    const r = await enableAdminDomain({ ...base, run });
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.error).toContain("sudo apt-get install google-cloud-cli");
    expect(calls.some((c) => c[0] === "beta")).toBe(false);
  });
});

describe("enableStagingDomain (#650)", () => {
  const STAGING_MAPPING = JSON.stringify({
    status: {
      resourceRecords: [{ name: "staging", type: "CNAME", rrdata: "ghs.googlehosted.com." }],
    },
  });

  it("opens the gateway's ingress, maps staging.<domain> to the gateway and prints the record", async () => {
    const { run, calls } = fakeGcloud({
      "run services list": [ok("caelo-production-gateway-xyz\n")],
      "run services describe": [ok("internal-and-cloud-load-balancing\n")],
      "beta run domain-mappings describe": [fail("NOT_FOUND"), ok(STAGING_MAPPING)],
      "domains list-user-verified": [ok("example.com\n")],
    });
    const { enableStagingDomain } = await import("./admin-domain.js");
    const r = await enableStagingDomain({ ...base, stagingHost: "staging.example.com", run });
    expect(r).toEqual({
      status: "mapped",
      hostname: "staging.example.com",
      created: true,
      records: [{ name: "staging.example.com", type: "CNAME", value: "ghs.googlehosted.com." }],
    });
    expect(calls).toContainEqual([
      "run",
      "services",
      "update",
      "caelo-production-gateway-xyz",
      "--region=europe-west1",
      "--project=p",
      "--ingress=all",
      "--quiet",
    ]);
    expect(calls.find((c) => c.includes("create"))).toContain(
      "--service=caelo-production-gateway-xyz",
    );
    expect(calls[0]).toContain("--filter=metadata.name~^caelo-production-gateway");
  });

  it("is idempotent: ingress already open and mapping present ⇒ no update, no create", async () => {
    const { run, calls } = fakeGcloud({
      "run services list": [ok("caelo-production-gateway-xyz\n")],
      "run services describe": [ok("all\n")],
      "beta run domain-mappings describe": [ok(STAGING_MAPPING)],
    });
    const { enableStagingDomain } = await import("./admin-domain.js");
    const r = await enableStagingDomain({ ...base, stagingHost: "staging.example.com", run });
    expect(r.status === "mapped" && !r.created).toBe(true);
    expect(calls.some((c) => c.includes("update") || c.includes("create"))).toBe(false);
  });

  it("maps a host the operator chose on another domain, verifying that host itself", async () => {
    const { run, calls } = fakeGcloud({
      "run services list": [ok("caelo-production-gateway-xyz\n")],
      "run services describe": [ok("all\n")],
      "beta run domain-mappings describe": [fail("NOT_FOUND")],
      "domains list-user-verified": [ok("example.com\n")],
    });
    const { enableStagingDomain } = await import("./admin-domain.js");
    const r = await enableStagingDomain({ ...base, stagingHost: "preview.other.de", run });
    expect(r).toEqual({
      status: "needs-verification",
      hostname: "preview.other.de",
      verifyDomain: "preview.other.de",
    });
    expect(calls).toContainEqual(["domains", "verify", "preview.other.de"]);
  });

  it("fails closed without exactly one gateway service", async () => {
    const { run } = fakeGcloud({ "run services list": [ok("a\nb\n")] });
    const { enableStagingDomain } = await import("./admin-domain.js");
    const r = await enableStagingDomain({ ...base, stagingHost: "staging.example.com", run });
    expect(r.status).toBe("failed");
  });

  it("installs the missing beta component before its first beta command", async () => {
    const { run, calls } = fakeGcloud({
      "components list": [ok("")],
      "run services list": [ok("caelo-production-gateway-xyz\n")],
      "run services describe": [ok("all\n")],
      "beta run domain-mappings describe": [ok(STAGING_MAPPING)],
    });
    const { enableStagingDomain } = await import("./admin-domain.js");
    const r = await enableStagingDomain({ ...base, stagingHost: "staging.example.com", run });
    expect(r.status).toBe("mapped");
    const install = calls.findIndex((c) => c.join(" ") === "components install beta --quiet");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(calls.findIndex((c) => c[0] === "beta"));
  });
});
