// SPDX-License-Identifier: MPL-2.0

/**
 * The bucket state lock (state-store.ts acquireBucketStateLock, #815)
 * against a fake bucket with object generations and a fake Cloud Run: a
 * dead holder's lock is broken, a live one never; every delete is
 * generation-matched, so two runs racing over one stale lock cannot both
 * win and a run never deletes a lock it did not judge.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { LEASE_SKEW_MS, lockBody } from "./state-lock-lease.js";
import {
  acquireBucketStateLock,
  bucketStateLockUrl,
  StateLockHeldError,
  type SyncGcloud,
} from "./state-store.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const PRECONDITION =
  "HTTPError 412: At least one of the pre-conditions you specified did not hold.";

const BUCKET = "acme-caelo-ops";
const URL = bucketStateLockUrl(BUCKET);
const HOUR = 60 * 60_000;
const T0 = new Date("2026-10-16T10:00:00Z");

type Execution = "running" | "succeeded" | "cancelled" | "missing" | "denied";

/** A bucket holding objects by generation, and Cloud Run's executions. */
function fakeCloud(executions: Record<string, Execution> = {}) {
  const objects = new Map<string, { generation: number; body: string }>();
  let nextGeneration = 1000;
  const calls: string[] = [];
  /** Runs once, right before the next generation-matched `rm` — to interleave a rival. */
  let beforeRm: (() => void) | null = null;
  const run: SyncGcloud = (args, input) => {
    calls.push(args.join(" "));
    const [svc, verb] = args;
    if (svc === "storage" && verb === "cp") {
      const url = args[3] ?? "";
      if (objects.has(url)) return fail(PRECONDITION);
      objects.set(url, { generation: nextGeneration++, body: input ?? "" });
      return ok();
    }
    if (svc === "storage" && verb === "objects") {
      const o = objects.get(args[3] ?? "");
      return o
        ? ok(JSON.stringify({ name: "install/state.lock", generation: String(o.generation) }))
        : fail("ERROR: NotFound 404: gs://… does not exist");
    }
    if (svc === "storage" && verb === "cat") {
      const o = objects.get(args[2] ?? "");
      return o ? ok(o.body) : fail("One or more URLs matched no objects.");
    }
    if (svc === "storage" && verb === "rm") {
      const url = args[2] ?? "";
      const match = args.find((a) => a.startsWith("--if-generation-match="));
      if (match && beforeRm) {
        const hook = beforeRm;
        beforeRm = null;
        hook();
      }
      const o = objects.get(url);
      if (!o) return fail("One or more URLs matched no objects.");
      if (match && match.split("=")[1] !== String(o.generation)) return fail(PRECONDITION);
      objects.delete(url);
      return ok();
    }
    if (svc === "run" && args[2] === "executions") {
      const state = executions[args[4] ?? ""] ?? "missing";
      const status = (s: string, reason?: string) =>
        ok(JSON.stringify({ status: { conditions: [{ type: "Completed", status: s, reason }] } }));
      switch (state) {
        case "running":
          return status("Unknown");
        case "succeeded":
          return status("True");
        case "cancelled":
          return status("False", "Cancelled");
        case "missing":
          return fail("ERROR: (gcloud.run.jobs.executions.describe) NOT_FOUND: Resource not found");
        case "denied":
          return fail("ERROR: PERMISSION_DENIED: run.executions.get");
      }
    }
    return fail(`unexpected: ${args.join(" ")}`);
  };
  return {
    run,
    calls,
    objects,
    lockBody: () => objects.get(URL)?.body ?? null,
    plantLock: (body: string) => objects.set(URL, { generation: nextGeneration++, body }),
    interleave: (hook: () => void) => {
      beforeRm = hook;
    },
  };
}

const jobHolder = (name: string) => ({
  execution: { projectId: "acme", region: "europe-west1", name },
  maxRuntimeMs: HOUR,
});
/** A lock run `name` took at T0. */
const jobLockAtT0 = (name: string) => lockBody("caelo upgrader job", T0, jobHolder(name));

describe("acquireBucketStateLock", () => {
  it("takes a free lock with the holder's execution and lease, and releases only its own generation", () => {
    const cloud = fakeCloud();
    const release = acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
      holder: jobHolder("x2"),
      now: () => T0,
    });
    expect(JSON.parse(cloud.lockBody() ?? "")).toMatchObject({
      execution: { name: "x2" },
      leaseUntil: new Date(T0.getTime() + HOUR + LEASE_SKEW_MS).toISOString(),
    });
    release();
    expect(cloud.objects.size).toBe(0);
    expect(cloud.calls.at(-1)).toBe(`storage rm ${URL} --if-generation-match=1000`);
  });

  it("breaks the lock of a finished run and takes it — and says so", () => {
    for (const how of ["succeeded", "cancelled"] as const) {
      const cloud = fakeCloud({ x1: how });
      cloud.plantLock(jobLockAtT0("x1"));
      const broke: string[] = [];
      const release = acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
        holder: jobHolder("x2"),
        onBreak: (m) => broke.push(m),
        now: () => new Date(T0.getTime() + 5 * 60_000),
      });
      expect(JSON.parse(cloud.lockBody() ?? "").execution.name).toBe("x2");
      expect(broke).toHaveLength(1);
      expect(broke[0]).toContain("run x1");
      // The stale lock was removed by its generation, never blindly.
      expect(cloud.calls).toContain(`storage rm ${URL} --if-generation-match=1000`);
      release();
    }
  });

  it("never breaks the lock of a running execution, even after its lease", () => {
    const cloud = fakeCloud({ x1: "running" });
    cloud.plantLock(jobLockAtT0("x1"));
    const before = cloud.lockBody();
    expect(() =>
      acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
        holder: jobHolder("x2"),
        now: () => new Date(T0.getTime() + 10 * HOUR),
      }),
    ).toThrow(StateLockHeldError);
    expect(cloud.lockBody()).toBe(before);
    expect(cloud.calls.some((c) => c.startsWith("storage rm"))).toBe(false);
  });

  it("a run Cloud Run no longer knows: held within its lease, broken after it", () => {
    const within = fakeCloud();
    within.plantLock(jobLockAtT0("x1"));
    expect(() =>
      acquireBucketStateLock(BUCKET, "caelo upgrader job", within.run, {
        now: () => new Date(T0.getTime() + 30 * 60_000),
      }),
    ).toThrow(/lease runs until/);

    const after = fakeCloud();
    after.plantLock(jobLockAtT0("x1"));
    acquireBucketStateLock(BUCKET, "caelo upgrader job", after.run, {
      now: () => new Date(T0.getTime() + HOUR + LEASE_SKEW_MS + 1),
    })();
    expect(after.objects.size).toBe(0);
  });

  it("a holder it cannot check is an access error, not 'busy', and the lock stays", () => {
    const cloud = fakeCloud({ x1: "denied" });
    cloud.plantLock(jobLockAtT0("x1"));
    let thrown: unknown;
    try {
      acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, { now: () => T0 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(StateLockHeldError);
    expect(String(thrown)).toContain("PERMISSION_DENIED");
    expect(cloud.lockBody()).toBe(jobLockAtT0("x1"));
  });

  it("a CLI run's lock is held, with the command to remove it by hand", () => {
    const cloud = fakeCloud();
    cloud.plantLock(lockBody("cms-provision upgrade", T0));
    expect(() =>
      acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
        now: () => new Date(T0.getTime() + 100 * HOUR),
      }),
    ).toThrow(`gcloud storage rm ${URL}`);
    expect(cloud.calls.some((c) => c.startsWith("run "))).toBe(false);
  });

  it("adversarial: two runs racing over one stale lock — exactly one wins, the other is told 'held'", () => {
    const cloud = fakeCloud({ x1: "succeeded", x2: "running", x3: "running" });
    cloud.plantLock(jobLockAtT0("x1"));
    const now = () => new Date(T0.getTime() + 2 * HOUR);
    let rivalRelease: (() => void) | null = null;
    // Run x3 has judged x1's lock dead; before its delete lands, run x2
    // breaks the same lock and takes it.
    cloud.interleave(() => {
      rivalRelease = acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
        holder: jobHolder("x2"),
        now,
      });
    });
    expect(() =>
      acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
        holder: jobHolder("x3"),
        now,
      }),
    ).toThrow(StateLockHeldError);
    // x3's generation-matched delete did not touch x2's fresh lock.
    expect(JSON.parse(cloud.lockBody() ?? "").execution.name).toBe("x2");
    expect(rivalRelease).not.toBeNull();
  });

  it("adversarial: two runs both breaking — the slower create loses instead of overwriting", () => {
    const cloud = fakeCloud({ x1: "succeeded", x2: "running" });
    cloud.plantLock(jobLockAtT0("x1"));
    const now = () => new Date(T0.getTime() + 2 * HOUR);
    // Right after x3 removed x1's lock, x2 (which found it free) takes it.
    let first = true;
    const run: SyncGcloud = (args, input) => {
      const r = cloud.run(args, input);
      if (first && args[1] === "rm" && r.ok) {
        first = false;
        cloud.run(["storage", "cp", "-", URL, "--if-generation-match=0"], jobLockAtT0("x2"));
      }
      return r;
    };
    expect(() =>
      acquireBucketStateLock(BUCKET, "caelo upgrader job", run, { holder: jobHolder("x3"), now }),
    ).toThrow(/at the same moment/);
    expect(JSON.parse(cloud.lockBody() ?? "").execution.name).toBe("x2");
  });

  it("a release after its lock was broken leaves the successor's lock alone", () => {
    const cloud = fakeCloud({ x1: "succeeded" });
    const release = acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
      holder: jobHolder("x1"),
      now: () => T0,
    });
    // Cloud Run says x1 finished (it was, say, a zombie); x2 takes over.
    const successor = acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
      holder: jobHolder("x2"),
      now: () => new Date(T0.getTime() + HOUR),
    });
    expect(() => release()).toThrow(/no longer this run's/);
    expect(JSON.parse(cloud.lockBody() ?? "").execution.name).toBe("x2");
    successor();
    expect(cloud.objects.size).toBe(0);
  });
});
