// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type GcloudResult, grantProvisionerRoles, PROVISIONER_ROLE_LIST } from "./gcloud.js";

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
