// SPDX-License-Identifier: MPL-2.0

/**
 * The parts of the converge job's Google Cloud wiring (#819) that parse
 * what gcloud says — which image an execution runs, which execution a
 * hand-over started — and its checkpoint document in the ops bucket.
 */

import { describe, expect, it } from "bun:test";
import {
  type ConvergeCheckpoint,
  convergeCheckpointUrl,
  readConvergeCheckpoint,
  writeConvergeCheckpoint,
} from "./converge-checkpoint.js";
import {
  convergeExecutionNameError,
  deployedOwnerMismatch,
  executionImageDigest,
  startedExecutionName,
} from "./converge-job-gcp.js";
import type { GcloudResult } from "./gcloud.js";
import type { SyncGcloud } from "./state-store.js";
import { installStateCondition } from "./upgrader-setup.js";

const D = `sha256:${"c".repeat(64)}`;
const OPS = `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/ops@${D}`;

describe("executionImageDigest", () => {
  it("reads the digest from gcloud's v1 execution (and the v2 shape)", () => {
    const v1 = { spec: { template: { spec: { containers: [{ image: OPS }] } } } };
    expect(executionImageDigest(JSON.stringify(v1))).toBe(D);
    expect(
      executionImageDigest(JSON.stringify({ template: { containers: [{ image: OPS }] } })),
    ).toBe(D);
  });

  it("is null for a tag, no container or unreadable output — never a guess", () => {
    const tag = { spec: { template: { spec: { containers: [{ image: "x/ops:0.11.0" }] } } } };
    expect(executionImageDigest(JSON.stringify(tag))).toBeNull();
    expect(executionImageDigest("{}")).toBeNull();
    expect(executionImageDigest("not json")).toBeNull();
  });
});

describe("startedExecutionName", () => {
  it("takes the name gcloud prints, or the one it announces on stderr", () => {
    expect(startedExecutionName("caelo-production-converge-x7k2p\n", "")).toBe(
      "caelo-production-converge-x7k2p",
    );
    expect(
      startedExecutionName(
        "",
        "Execution [caelo-production-converge-q1w2e] has successfully started",
      ),
    ).toBe("caelo-production-converge-q1w2e");
    expect(startedExecutionName("", "")).toBeNull();
    expect(startedExecutionName("Bad Name; rm -rf", "")).toBeNull();
  });
});

describe("the converge checkpoint", () => {
  const BUCKET = "acme-caelo-ops";
  const fakeBucket = () => {
    const objects = new Map<string, string>();
    const run: SyncGcloud = (args, input): GcloudResult => {
      if (args[1] === "cat") {
        const v = objects.get(args[2] as string);
        return v === undefined
          ? { ok: false, stdout: "", stderr: "One or more URLs matched no objects.", exitCode: 1 }
          : { ok: true, stdout: v, stderr: "", exitCode: 0 };
      }
      objects.set(args[3] as string, input ?? "");
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    };
    return { run, objects };
  };
  const CHECKPOINT: ConvergeCheckpoint = {
    statusVersion: 1,
    installId: "gcp-acme",
    execution: "caelo-production-converge-x7k2p",
    state: "running",
    phase: "converge",
    caeloVersion: "0.11.0",
    startedAt: "2026-10-19T12:00:00Z",
    updatedAt: "2026-10-19T12:05:00Z",
    targetVersion: "0.11.0",
    fromVersion: "0.10.53",
    requestId: "11111111-2222-4333-8444-555555555555",
    backup: { projectId: "acme", instance: "caelo-production-pg-x", backupId: "1760000000" },
    priorRevisions: { admin: "a-00001", gateway: "g-00001" },
  };

  it("lives outside install/, where the upgrader may write, and round-trips (#883 review)", () => {
    const { run, objects } = fakeBucket();
    expect(readConvergeCheckpoint(BUCKET, run)).toBeNull();
    writeConvergeCheckpoint(BUCKET, CHECKPOINT, run);
    expect([...objects.keys()]).toEqual(["gs://acme-caelo-ops/converge/converge-job.json"]);
    expect(convergeCheckpointUrl(BUCKET)).toBe("gs://acme-caelo-ops/converge/converge-job.json");
    expect(readConvergeCheckpoint(BUCKET, run)).toEqual(CHECKPOINT);
    // The upgrader's only object grant on the bucket is conditioned on
    // install/ — the checkpoint is not under it.
    const condition = installStateCondition(BUCKET);
    const prefix = /objects\/([^"]+)"/.exec(condition)?.[1] ?? "";
    expect(prefix).toBe("install/");
    expect(convergeCheckpointUrl(BUCKET).startsWith(`gs://${BUCKET}/${prefix}`)).toBe(false);
  });

  it("refuses a document it does not understand", () => {
    const { run, objects } = fakeBucket();
    objects.set(convergeCheckpointUrl(BUCKET), JSON.stringify({ ...CHECKPOINT, fromVersion: "x" }));
    expect(() => readConvergeCheckpoint(BUCKET, run)).toThrow(/not a job status/);
  });
});

describe("deployedOwnerMismatch (#883 review)", () => {
  const job = (members: string | null) =>
    JSON.stringify({
      spec: {
        template: {
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    env: [
                      { name: "CAELO_OPERATOR_ACCESS_IAP_WEB", value: "x" },
                      ...(members === null
                        ? []
                        : [{ name: "CAELO_OPERATOR_ACCESS_STATIC_MEMBERS", value: members }]),
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });

  it("accepts install.json's Owner when the deployed IAP members are exactly it", () => {
    expect(deployedOwnerMismatch(job("user:owner@acme.com"), "Owner@Acme.com")).toBeNull();
  });

  it("refuses an Owner email the deployed access settings do not admit (a tampered install.json)", () => {
    const why = deployedOwnerMismatch(job("user:owner@acme.com"), "attacker@evil.example");
    expect(why).toContain("user:owner@acme.com");
    expect(why).toContain("user:attacker@evil.example");
  });

  it("refuses when the deployed members cannot be read — never assumes they match", () => {
    expect(deployedOwnerMismatch(job(null), "owner@acme.com")).toContain("sets no");
    expect(deployedOwnerMismatch("not json", "owner@acme.com")).toContain("not JSON");
    expect(
      deployedOwnerMismatch(job("user:owner@acme.com,user:x@y.z"), "owner@acme.com"),
    ).not.toBeNull();
  });
});

describe("convergeExecutionNameError (#883 review)", () => {
  it("accepts a run of the converge job and no name at all (outside Cloud Run)", () => {
    expect(convergeExecutionNameError("caelo-production-converge-x7k2p")).toBeNull();
    expect(convergeExecutionNameError(null)).toBeNull();
  });

  it("refuses a run of another job or a value that is no Cloud Run name", () => {
    expect(convergeExecutionNameError("caelo-production-upgrader-x1")).not.toBeNull();
    expect(convergeExecutionNameError("caelo-production-converge-X;rm")).not.toBeNull();
  });
});
