// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  checkGcloudAuth,
  type GcloudResult,
  grantProvisionerRoles,
  isGcloudAuthError,
  isGcloudNotFound,
  PROVISIONER_ROLE_LIST,
  parseBillingAccounts,
  parseProjectBillingInfo,
  projectDisplayName,
} from "./gcloud.js";

const ok: GcloudResult = { ok: true, stdout: "", stderr: "", exitCode: 0 };
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const SA_NOT_YET_VISIBLE =
  "ERROR: (gcloud.projects.add-iam-policy-binding) INVALID_ARGUMENT: Service account caelo-provisioner@p.iam.gserviceaccount.com does not exist.";
const PERMISSION_DENIED =
  "ERROR: (gcloud.projects.add-iam-policy-binding) PERMISSION_DENIED: Policy update access denied.";

/** Fake gcloud: answers each call for `role` from its queue, `ok` once the queue is empty. */
function fakeGcloud(responses: Record<string, GcloudResult[]>) {
  const calls: string[] = [];
  const run = async (args: string[]): Promise<GcloudResult> => {
    const role = args[args.indexOf("--role") + 1] as string;
    calls.push(role);
    return responses[role]?.shift() ?? ok;
  };
  return { run, calls };
}

const noSleep = async () => {};

describe("grantProvisionerRoles", () => {
  it("binds only the given roles when asked (#696 install-job extras)", async () => {
    const { run, calls } = fakeGcloud({});
    const roles = ["roles/iam.roleAdmin", "roles/cloudscheduler.admin"];
    const result = await grantProvisionerRoles("p", "sa@p", { run, sleep: noSleep, roles });
    expect(result).toEqual({ granted: 2, failed: [] });
    expect(calls).toEqual(roles);
  });

  it("retries a freshly created SA that IAM does not see yet (regression: first role failed right after SA create)", async () => {
    const first = PROVISIONER_ROLE_LIST[0] as string;
    const { run, calls } = fakeGcloud({
      [first]: [fail(SA_NOT_YET_VISIBLE), fail(SA_NOT_YET_VISIBLE)],
    });
    const slept: number[] = [];

    const result = await grantProvisionerRoles("p", "sa@p", {
      run,
      sleep: async (ms) => {
        slept.push(ms);
      },
      retryDelaysMs: [10, 20, 40],
    });

    expect(result).toEqual({ granted: PROVISIONER_ROLE_LIST.length, failed: [] });
    expect(calls.filter((r) => r === first)).toHaveLength(3);
    expect(slept).toEqual([10, 20]);
  });

  it("retries concurrent policy changes", async () => {
    const role = PROVISIONER_ROLE_LIST[1] as string;
    const { run } = fakeGcloud({
      [role]: [
        fail(
          "ERROR: ABORTED: There were concurrent policy changes. Please retry the whole read-modify-write with exponential backoff.",
        ),
      ],
    });

    const result = await grantProvisionerRoles("p", "sa@p", { run, sleep: noSleep });

    expect(result.failed).toEqual([]);
  });

  it("does not retry a permission error and reports gcloud's message", async () => {
    const role = PROVISIONER_ROLE_LIST[0] as string;
    const { run, calls } = fakeGcloud({
      [role]: [fail(PERMISSION_DENIED), fail(PERMISSION_DENIED)],
    });

    const result = await grantProvisionerRoles("p", "sa@p", { run, sleep: noSleep });

    expect(calls.filter((r) => r === role)).toHaveLength(1);
    expect(result.granted).toBe(PROVISIONER_ROLE_LIST.length - 1);
    expect(result.failed).toEqual([{ role, error: PERMISSION_DENIED }]);
  });

  it("gives up after the last retry and reports the last error", async () => {
    const role = PROVISIONER_ROLE_LIST[0] as string;
    const { run, calls } = fakeGcloud({
      [role]: Array.from({ length: 10 }, () => fail(SA_NOT_YET_VISIBLE)),
    });

    const result = await grantProvisionerRoles("p", "sa@p", {
      run,
      sleep: noSleep,
      retryDelaysMs: [1, 1],
    });

    expect(calls.filter((r) => r === role)).toHaveLength(3);
    expect(result.failed).toEqual([{ role, error: SA_NOT_YET_VISIBLE }]);
  });
});

// Mirrors the Resource Manager displayName rule: 4–30 chars of letters,
// digits, spaces, hyphens, quotes and `!`.
const GCP_DISPLAY_NAME = /^[A-Za-z0-9 '"!-]{4,30}$/;

describe("projectDisplayName", () => {
  it("names the project after the domain so installs are distinguishable", () => {
    expect(projectDisplayName("searchviu.com")).toBe("Caelo searchviu-com");
    expect(projectDisplayName("docs.caelo-cms.com")).toBe("Caelo docs-caelo-cms-com");
  });

  it("stays within the GCP displayName rules for long or odd domains", () => {
    for (const domain of [
      "a-very-long-subdomain.of-an-even-longer-domain.example.co.uk",
      "Example.COM",
      "xn--mnchen-3ya.de",
      "ab.c",
    ]) {
      const name = projectDisplayName(domain);
      expect(name).toMatch(GCP_DISPLAY_NAME);
      expect(name).not.toMatch(/-$/);
    }
  });
});

describe("checkGcloudAuth (#630)", () => {
  const account = { ...ok, stdout: "owner@acme.com\n" };
  const runner = (token: GcloudResult, list: GcloudResult = account) => {
    const calls: string[] = [];
    const run = async (args: string[]): Promise<GcloudResult> => {
      calls.push(args.join(" "));
      return args[1] === "list" ? list : token;
    };
    return { run, calls };
  };

  it("passes when gcloud can mint a token", async () => {
    const { run, calls } = runner({ ...ok, stdout: "ya29.secret" });
    expect(await checkGcloudAuth(run)).toEqual({ ok: true, account: "owner@acme.com" });
    expect(calls[1]).toBe("auth print-access-token --quiet");
  });

  it("expired credentials pass `auth list` but fail here, with the login fix", async () => {
    const { run } = runner(
      fail(
        "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.",
      ),
    );
    const r = await checkGcloudAuth(run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("gcloud auth login");
    expect(r.error).toContain("owner@acme.com");
  });

  it("no logged-in account", async () => {
    const { run } = runner(ok, ok);
    const r = await checkGcloudAuth(run);
    expect(r).toEqual({
      ok: false,
      error:
        "No gcloud account is logged in. Run `gcloud auth login` with the Owner's Google account, then run this command again.",
    });
  });

  it("another failure names gcloud's error, not expired credentials", async () => {
    const { run } = runner(fail("ERROR: network unreachable"));
    const r = await checkGcloudAuth(run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("network unreachable");
    expect(r.error).not.toContain("expired");
  });

  it("recognises the reauth failures gcloud prints", () => {
    for (const stderr of [
      "Reauthentication failed. cannot prompt during non-interactive execution.",
      "google.auth.exceptions.RefreshError: ('invalid_grant: Bad Request', ...)",
      "Please run: $ gcloud auth login to obtain new credentials. reauth related error (invalid_rapt)",
    ]) {
      expect(isGcloudAuthError(stderr)).toBe(true);
    }
    expect(isGcloudAuthError("PERMISSION_DENIED: run.services.list")).toBe(false);
  });
});

describe("isGcloudNotFound — one list of every service's wording", () => {
  it.each([
    "ERROR: (gcloud.run.services.describe) Cannot find service [caelo-production-gateway-aa7db32]",
    "ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [x] not found or has no versions.",
    "ERROR: (gcloud.compute.backend-services.describe) The resource 'projects/p/global/backendServices/b' was not found",
    "ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account.",
    "HTTPError 404: Not Found",
    'ERROR: {"error": {"code": 404, "message": "Requested entity was not found."}}',
    "ERROR: (gcloud.run.jobs.executions.describe) Execution [e] could not be found.",
  ])("reads %p as missing", (stderr) => {
    expect(isGcloudNotFound(stderr)).toBe(true);
  });

  it.each([
    "ERROR: (gcloud.iam.service-accounts.describe) PERMISSION_DENIED",
    "ERROR: (gcloud.run.services.describe) There was a problem refreshing your current auth tokens",
    "ERROR: project 4041234 quota exceeded",
    "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: on projects/caelo-404-prod/locations/europe-west1",
  ])("does not read %p as missing", (stderr) => {
    expect(isGcloudNotFound(stderr)).toBe(false);
  });
});

describe("parseBillingAccounts (#1580)", () => {
  it("reads gcloud's JSON list into ids without the resource-name prefix", () => {
    const stdout = JSON.stringify([
      {
        name: "billingAccounts/0A1B2C-3D4E5F-60718A",
        displayName: "Agency",
        open: true,
        masterBillingAccount: "",
      },
      { name: "billingAccounts/999999-888888-777777", displayName: "Old card", open: false },
    ]);
    expect(parseBillingAccounts(stdout)).toEqual({
      ok: true,
      accounts: [
        { id: "0A1B2C-3D4E5F-60718A", displayName: "Agency", open: true },
        { id: "999999-888888-777777", displayName: "Old card", open: false },
      ],
    });
  });

  it("reads an empty list as no accounts", () => {
    expect(parseBillingAccounts("[]")).toEqual({ ok: true, accounts: [] });
  });

  it.each(["", "not json", '{"name":"billingAccounts/x"}', '[{"name":"billingAccounts/x"}]'])(
    "reads %p as an error, never as no accounts",
    (stdout) => {
      const r = parseBillingAccounts(stdout);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toContain("gcloud billing accounts list");
    },
  );
});

describe("parseProjectBillingInfo (#1580)", () => {
  it("reads the linked account's id without the resource-name prefix", () => {
    const stdout = JSON.stringify({
      billingAccountName: "billingAccounts/0A1B2C-3D4E5F-60718A",
      billingEnabled: true,
      name: "projects/p/billingInfo",
      projectId: "p",
    });
    expect(parseProjectBillingInfo(stdout)).toEqual({
      ok: true,
      accountId: "0A1B2C-3D4E5F-60718A",
    });
  });

  it("reads an empty account name as no link", () => {
    const stdout = JSON.stringify({
      billingAccountName: "",
      billingEnabled: false,
      projectId: "p",
    });
    expect(parseProjectBillingInfo(stdout)).toEqual({ ok: true, accountId: null });
    expect(parseProjectBillingInfo('{"projectId":"p"}')).toEqual({ ok: true, accountId: null });
  });

  it.each(["", "not json", "[]", '{"billingAccountName":42}'])("reads %p as an error", (stdout) => {
    const r = parseProjectBillingInfo(stdout);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("gcloud billing projects describe");
  });
});
