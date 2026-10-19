// SPDX-License-Identifier: MPL-2.0

/**
 * The bucket state lock (state-store.ts acquireBucketStateLock, #815)
 * against a fake bucket with object generations and a fake Cloud Run: a
 * dead holder's lock is broken, a live one never; every delete is
 * generation-matched, so two runs racing over one stale lock cannot both
 * win and a run never deletes a lock it did not judge.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GcloudResult } from "./gcloud.js";
import { LEASE_SKEW_MS, type LocalHost, lockBody, PROCESS_LEASE_MS } from "./state-lock-lease.js";
import {
  acquireBucketStateLock,
  acquireLocalStateLock,
  bucketStateLockUrl,
  releaseOnSignal,
  type SignalTarget,
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
      const match = args.find((a) => a.startsWith("--if-generation-match="))?.split("=")[1];
      const o = objects.get(url);
      if (match === "0" && o) return fail(PRECONDITION);
      if (match !== undefined && match !== "0" && o?.generation !== Number(match)) {
        return fail(PRECONDITION);
      }
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
const jobLockAtT0 = (name: string) =>
  lockBody("caelo upgrader job", T0, jobHolder(name), `id-${name}`);

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

  it("#818: a generation gcloud does not print as a digit string is not trusted for the release", () => {
    // `gcloud storage objects describe` prints `generation: '1706304784726341'`
    // (a string); a JSON number past 2^53 would have lost digits.
    for (const generation of [1000, "", "12a"]) {
      const cloud = fakeCloud();
      const run: SyncGcloud = (args, input) =>
        args[1] === "objects"
          ? ok(JSON.stringify({ name: "install/state.lock", generation }))
          : cloud.run(args, input);
      expect(() =>
        acquireBucketStateLock(BUCKET, "caelo upgrader job", run, {
          holder: jobHolder("x2"),
          now: () => T0,
        }),
      ).toThrow(/without a generation.*expires with its lease/);
      // Never deleted blind: an unverifiable generation leaves the lock to
      // its lease (#872 review), and the error says so.
      expect(cloud.objects.size).toBe(1);
      expect(cloud.calls.some((c) => c.startsWith("storage rm"))).toBe(false);
    }
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

/** A heartbeat the test drives by hand. */
function manualHeartbeat() {
  let tick: (() => void) | null = null;
  let every = 0;
  let stopped = false;
  return {
    schedule: (fn: () => void, ms: number) => {
      tick = fn;
      every = ms;
      return () => {
        stopped = true;
      };
    },
    beat: () => tick?.(),
    every: () => every,
    stopped: () => stopped,
  };
}

/** A CLI lock taken on `host` by `pid`, with a lease renewed last at `renewedAt`. */
const cliLock = (host: string, pid: number, renewedAt: Date) =>
  JSON.stringify({
    purpose: "cms-provision upgrade",
    id: `cli-${host}-${pid}`,
    host,
    pid,
    startedAt: T0.toISOString(),
    leaseUntil: new Date(renewedAt.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS).toISOString(),
  });

const HERE: LocalHost = { host: "laptop", alive: (pid) => pid === 4242 };

describe("acquireBucketStateLock — a CLI holder (#815 review)", () => {
  it("a CLI lock names host + pid and a lease, renewed by its heartbeat until released", () => {
    const cloud = fakeCloud();
    const hb = manualHeartbeat();
    let clock = T0;
    const release = acquireBucketStateLock(BUCKET, "cms-provision upgrade", cloud.run, {
      now: () => clock,
      schedule: hb.schedule,
    });
    const first = JSON.parse(cloud.lockBody() ?? "");
    expect(first).toMatchObject({ purpose: "cms-provision upgrade", pid: process.pid });
    expect(typeof first.host).toBe("string");
    expect(first.leaseUntil).toBe(
      new Date(T0.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS).toISOString(),
    );
    expect(hb.every()).toBe(Math.floor(PROCESS_LEASE_MS / 3));

    // An hour-long upgrade keeps its lock: every beat moves the lease on.
    clock = new Date(T0.getTime() + HOUR);
    hb.beat();
    const renewed = JSON.parse(cloud.lockBody() ?? "");
    expect(renewed.id).toBe(first.id);
    expect(renewed.leaseUntil).toBe(
      new Date(clock.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS).toISOString(),
    );
    // A run judging at that moment finds it held.
    expect(() =>
      acquireBucketStateLock(BUCKET, "caelo upgrader job", cloud.run, {
        holder: jobHolder("x2"),
        now: () => new Date(clock.getTime() + 60_000),
      }),
    ).toThrow(StateLockHeldError);

    // Release stops the heartbeat and deletes the renewed generation.
    release();
    expect(hb.stopped()).toBe(true);
    expect(cloud.objects.size).toBe(0);
  });

  it("a killed CLI on another machine (closed Cloud Shell): held within its lease, broken after it", () => {
    const within = fakeCloud();
    within.plantLock(cliLock("cs-123", 77, T0));
    expect(() =>
      acquireBucketStateLock(BUCKET, "caelo upgrader job", within.run, {
        holder: jobHolder("x2"),
        now: () => new Date(T0.getTime() + PROCESS_LEASE_MS),
        here: HERE,
      }),
    ).toThrow(/unless renewed/);

    const after = fakeCloud();
    after.plantLock(cliLock("cs-123", 77, T0));
    const broke: string[] = [];
    const release = acquireBucketStateLock(BUCKET, "caelo upgrader job", after.run, {
      holder: jobHolder("x2"),
      now: () => new Date(T0.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS + 1),
      here: HERE,
      onBreak: (m) => broke.push(m),
    });
    expect(broke[0]).toContain("stopped renewing its lock");
    expect(JSON.parse(after.lockBody() ?? "").execution.name).toBe("x2");
    release();
    // Never asked Cloud Run about a CLI holder.
    expect(after.calls.some((c) => c.startsWith("run "))).toBe(false);
  });

  it("a CLI lock of this machine whose process is gone is broken at once, a live one is not", () => {
    const dead = fakeCloud();
    dead.plantLock(cliLock("laptop", 9999, T0));
    acquireBucketStateLock(BUCKET, "cms-provision upgrade", dead.run, {
      now: () => new Date(T0.getTime() + 60_000),
      here: HERE,
      schedule: manualHeartbeat().schedule,
    })();
    expect(dead.objects.size).toBe(0);

    const live = fakeCloud();
    live.plantLock(cliLock("laptop", 4242, T0));
    expect(() =>
      acquireBucketStateLock(BUCKET, "cms-provision upgrade", live.run, {
        now: () => new Date(T0.getTime() + 60_000),
        here: HERE,
      }),
    ).toThrow(StateLockHeldError);
  });

  it("a heartbeat that finds its lock broken reports it, stops renewing, and leaves the successor", () => {
    const cloud = fakeCloud();
    const hb = manualHeartbeat();
    const lost: string[] = [];
    const release = acquireBucketStateLock(BUCKET, "cms-provision upgrade", cloud.run, {
      now: () => T0,
      schedule: hb.schedule,
      onLost: (m) => lost.push(m),
    });
    // The laptop slept past the lease; a job broke the lock and took it.
    cloud.objects.delete(URL);
    cloud.plantLock(jobLockAtT0("x9"));
    const successor = cloud.lockBody();
    hb.beat();
    hb.beat();
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("no longer holds");
    expect(cloud.lockBody()).toBe(successor);
    expect(() => release()).toThrow(/no longer this run's/);
    expect(cloud.lockBody()).toBe(successor);
  });

  it("give-back after an unreadable generation: deleted only by a verified generation, else left to the lease", () => {
    // The first describe fails, the second works: the lock is verified as
    // this run's and removed by its generation.
    const flaky = fakeCloud();
    let describes = 0;
    const once: SyncGcloud = (args, input) => {
      if (args[1] === "objects" && describes++ === 0) return fail("ERROR: 503 backend error");
      return flaky.run(args, input);
    };
    expect(() =>
      acquireBucketStateLock(BUCKET, "cms-provision upgrade", once, { now: () => T0 }),
    ).toThrow(/It was given back/);
    expect(flaky.objects.size).toBe(0);
    expect(flaky.calls.filter((c) => c.startsWith("storage rm"))).toEqual([
      `storage rm ${URL} --if-generation-match=1000`,
    ]);

    // Never readable: nothing is deleted blindly — the lease ends the lock.
    const blind = fakeCloud();
    const never: SyncGcloud = (args, input) =>
      args[1] === "objects" ? fail("ERROR: 503 backend error") : blind.run(args, input);
    expect(() =>
      acquireBucketStateLock(BUCKET, "cms-provision upgrade", never, { now: () => T0 }),
    ).toThrow(/expires with its lease/);
    expect(blind.objects.size).toBe(1);
    expect(blind.calls.some((c) => c.startsWith("storage rm"))).toBe(false);

    // Replaced by another run in between: its lock is never touched.
    const raced = fakeCloud();
    let first = true;
    const rival: SyncGcloud = (args, input) => {
      if (args[1] === "objects" && first) {
        first = false;
        raced.objects.delete(URL);
        raced.plantLock(jobLockAtT0("x5"));
        return fail("ERROR: 503 backend error");
      }
      return raced.run(args, input);
    };
    expect(() =>
      acquireBucketStateLock(BUCKET, "cms-provision upgrade", rival, { now: () => T0 }),
    ).toThrow(/expires with its lease/);
    expect(JSON.parse(raced.lockBody() ?? "").execution.name).toBe("x5");
  });
});

describe("acquireLocalStateLock (#815 review)", () => {
  it("takes over a lock whose process is gone on this machine; a live holder's stays", () => {
    const root = mkdtempSync(join(tmpdir(), "caelo-lock-"));
    try {
      writeFileSync(join(root, "state.lock"), cliLock("laptop", 9999, T0));
      const release = acquireLocalStateLock(root, "cms-provision upgrade", HERE);
      expect(JSON.parse(readFileSync(join(root, "state.lock"), "utf8")).pid).toBe(process.pid);
      release();

      writeFileSync(join(root, "state.lock"), cliLock("laptop", 4242, new Date()));
      expect(() => acquireLocalStateLock(root, "cms-provision upgrade", HERE)).toThrow(
        StateLockHeldError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("releaseOnSignal (#815 review)", () => {
  function fakeProcess() {
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const proc: SignalTarget = {
      once: (signal, listener) => listeners.set(signal, listener),
      removeListener: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
      exit: (code) => {
        exits.push(code);
        return undefined as never;
      },
    };
    return { proc, listeners, exits };
  }

  it("Ctrl-C or SIGTERM gives the lock back, then exits with the signal's code", () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const p = fakeProcess();
      const released: string[] = [];
      const said: string[] = [];
      releaseOnSignal(
        () => released.push("lock"),
        (m) => said.push(m),
        p.proc,
      );
      p.listeners.get(signal)?.();
      expect(released).toEqual(["lock"]);
      expect(p.exits).toEqual([code]);
      expect(said[0]).toContain("state lock was released");
      expect(p.listeners.size).toBe(0);
    }
  });

  it("a failed release is reported, and the process still exits", () => {
    const p = fakeProcess();
    const said: string[] = [];
    releaseOnSignal(
      () => {
        throw new Error("Could not release gs://x; remove it");
      },
      (m) => said.push(m),
      p.proc,
    );
    p.listeners.get("SIGTERM")?.();
    expect(said[0]).toContain("Could not release");
    expect(p.exits).toEqual([143]);
  });

  it("once the run released the lock itself, the handlers are gone", () => {
    const p = fakeProcess();
    const dispose = releaseOnSignal(
      () => {},
      () => {},
      p.proc,
    );
    expect(p.listeners.size).toBe(2);
    dispose();
    expect(p.listeners.size).toBe(0);
  });
});
