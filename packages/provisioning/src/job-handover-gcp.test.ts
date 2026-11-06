// SPDX-License-Identifier: MPL-2.0

/**
 * What an update job does to itself (#819, #1029). The trust boundary
 * rests on these argv: the image moves by digest and nothing else moves, and
 * the new execution carries no override of args or env (no principal but
 * the provisioner may run a job with overrides, CLAUDE.md §11.C).
 */

import { describe, expect, it } from "bun:test";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  executionImageDigest,
  jobExecutionNameError,
  selfHandoverDeps,
  startedExecutionName,
} from "./job-handover-gcp.js";

const D = `sha256:${"c".repeat(64)}`;
const OPS = `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/ops@${D}`;
const JOB = "caelo-production-upgrader";

function fake(stdout = "caelo-production-upgrader-abc12\n") {
  const calls: string[][] = [];
  const run: GcloudRunner = async (args) => {
    calls.push(args);
    return { ok: true, stdout, stderr: "", exitCode: 0 };
  };
  const deps = selfHandoverDeps(run, {
    job: JOB,
    projectId: "acme",
    region: "europe-west1",
    execution: `${JOB}-x1`,
  });
  return { calls, deps };
}

describe("selfHandoverDeps", () => {
  it("points the job at the digest and changes nothing else", async () => {
    const { calls, deps } = fake();
    await deps.pointJobAt(D);
    expect(calls).toEqual([
      [
        "run",
        "jobs",
        "update",
        JOB,
        `--image=${OPS}`,
        "--region=europe-west1",
        "--project=acme",
        "--quiet",
      ],
    ]);
  });

  it("starts the job with no override of its args, env or task", async () => {
    const { calls, deps } = fake();
    expect(await deps.startJob()).toEqual({
      ok: true,
      execution: "caelo-production-upgrader-abc12",
    });
    expect(calls).toEqual([
      [
        "run",
        "jobs",
        "execute",
        JOB,
        "--region=europe-west1",
        "--project=acme",
        "--async",
        "--format=value(metadata.name)",
      ],
    ]);
  });

  it("reads this execution's image, and nothing outside Cloud Run", async () => {
    const { calls, deps } = fake(
      JSON.stringify({ spec: { template: { spec: { containers: [{ image: OPS }] } } } }),
    );
    expect(await deps.ownImageDigest()).toBe(D);
    expect(calls[0]?.slice(0, 5)).toEqual(["run", "jobs", "executions", "describe", `${JOB}-x1`]);
    const outside = selfHandoverDeps(
      async () => ({ ok: false, stdout: "", stderr: "", exitCode: 1 }),
      {
        job: JOB,
        projectId: "acme",
        region: "europe-west1",
        execution: null,
      },
    );
    expect(await outside.ownImageDigest()).toBeNull();
  });
});

describe("jobExecutionNameError", () => {
  it("accepts a run of the job and no other name", () => {
    expect(jobExecutionNameError(JOB, null)).toBeNull();
    expect(jobExecutionNameError(JOB, `${JOB}-abc12`)).toBeNull();
    expect(jobExecutionNameError(JOB, "caelo-production-converge-abc12")).toContain("not a run of");
    expect(jobExecutionNameError(JOB, `${JOB}-ABC`)).toContain("not a run of");
    expect(jobExecutionNameError(JOB, JOB)).toContain("not a run of");
  });
});

describe("executionImageDigest", () => {
  it("reads both shapes gcloud can print", () => {
    const v1 = { spec: { template: { spec: { containers: [{ image: OPS }] } } } };
    expect(executionImageDigest(JSON.stringify(v1))).toBe(D);
    expect(
      executionImageDigest(JSON.stringify({ template: { containers: [{ image: OPS }] } })),
    ).toBe(D);
  });

  it("is null for a tag, an empty description or bad JSON: never a guess", () => {
    const tag = { template: { containers: [{ image: "x/ops:0.11.0" }] } };
    expect(executionImageDigest(JSON.stringify(tag))).toBeNull();
    expect(executionImageDigest("{}")).toBeNull();
    expect(executionImageDigest("not json")).toBeNull();
  });
});

describe("startedExecutionName", () => {
  it("reads --format output, or gcloud's stderr line", () => {
    expect(startedExecutionName("job-abc12\n", "")).toBe("job-abc12");
    expect(startedExecutionName("", "Execution [job-abc12] has started")).toBe("job-abc12");
    expect(startedExecutionName("", "")).toBeNull();
    expect(startedExecutionName("Bad Name; rm -rf", "")).toBeNull();
  });
});
