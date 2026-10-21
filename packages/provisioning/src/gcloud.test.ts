// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  checkGcloudAuth,
  type GcloudResult,
  grantProvisionerRoles,
  isGcloudAuthError,
  PROVISIONER_ROLE_LIST,
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
