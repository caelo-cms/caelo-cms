// SPDX-License-Identifier: MPL-2.0

/**
 * The state lock's lease (state-lock-lease.ts, #815): when a held lock may
 * be broken, and how Cloud Run's execution status is read.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import {
  type CloudRunExecutionRef,
  type ExecutionState,
  judgeHeldLock,
  LEASE_SKEW_MS,
  type LocalHost,
  lockBody,
  machineId,
  PROCESS_LEASE_MS,
  parseExecutionState,
  parseLockBody,
  renewedLockBody,
} from "./state-lock-lease.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const EXEC: CloudRunExecutionRef = {
  projectId: "acme",
  region: "europe-west1",
  name: "caelo-production-upgrader-x1",
};
const START = new Date("2026-10-16T10:00:00Z");
const HOUR = 60 * 60_000;
/** The lease of a lock taken at START by a one-hour job. */
const LEASE_END = START.getTime() + HOUR + LEASE_SKEW_MS;

const jobLock = lockBody("caelo upgrader job", START, { execution: EXEC, maxRuntimeMs: HOUR });
const at = (ms: number) => new Date(ms);
const state =
  (s: ExecutionState) =>
  (ref: CloudRunExecutionRef): ExecutionState => {
    expect(ref).toEqual(EXEC);
    return s;
  };

describe("lockBody", () => {
  it("an execution's lock names the execution and a lease of task timeout + skew", () => {
    const body = parseLockBody(jobLock);
    expect(body?.execution).toEqual(EXEC);
    expect(body?.leaseUntil).toBe(new Date(LEASE_END).toISOString());
  });

  it("a machine-local lock (no holder) carries neither", () => {
    const body = parseLockBody(lockBody("cms-provision upgrade", START));
    expect(body?.purpose).toBe("cms-provision upgrade");
    expect(body?.execution).toBeUndefined();
    expect(body?.leaseUntil).toBeUndefined();
  });

  it("a CLI process's lock names host + pid, a unique id and a lease of leaseMs + skew", () => {
    const a = parseLockBody(
      lockBody("cms-provision upgrade", START, { leaseMs: PROCESS_LEASE_MS }),
    );
    const b = parseLockBody(
      lockBody("cms-provision upgrade", START, { leaseMs: PROCESS_LEASE_MS }),
    );
    expect(a?.pid).toBe(process.pid);
    expect(a?.host).toBeTruthy();
    expect(a?.execution).toBeUndefined();
    expect(a?.leaseUntil).toBe(
      new Date(START.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS).toISOString(),
    );
    expect(a?.id).toBeTruthy();
    expect(a?.id).not.toBe(b?.id);
  });

  it("a renewed body keeps its id and start and moves only the lease", () => {
    const body = parseLockBody(
      lockBody("cms-provision upgrade", START, { leaseMs: PROCESS_LEASE_MS }, "id-1"),
    );
    if (!body) throw new Error("unparsable");
    const later = at(START.getTime() + 3 * HOUR);
    const renewed = parseLockBody(renewedLockBody(body, later, PROCESS_LEASE_MS));
    expect(renewed).toMatchObject({ id: "id-1", startedAt: START.toISOString() });
    expect(renewed?.leaseUntil).toBe(
      new Date(later.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS).toISOString(),
    );
  });
});

describe("judgeHeldLock — a CLI process holder (#815 review)", () => {
  const HERE: LocalHost = { host: "laptop", alive: (pid) => pid === 4242 };
  const cli = (host: string, pid: number) =>
    JSON.stringify({
      purpose: "cms-provision upgrade",
      host,
      pid,
      startedAt: START.toISOString(),
      leaseUntil: new Date(START.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS).toISOString(),
    });
  const LEASE = START.getTime() + PROCESS_LEASE_MS + LEASE_SKEW_MS;
  const never = () => {
    throw new Error("Cloud Run must not be asked about a CLI holder");
  };

  it("its own host's lock whose pid is dead is broken at once, inside the lease", () => {
    const v = judgeHeldLock(cli("laptop", 9999), never, at(START.getTime() + 1), HERE);
    expect(v.kind).toBe("break");
    expect(v.why).toContain("process is gone");
  });

  it("its own host's lock whose pid lives is held until the lease ends", () => {
    expect(judgeHeldLock(cli("laptop", 4242), never, at(LEASE), HERE)).toMatchObject({
      kind: "held",
      manualRemoval: false,
    });
    expect(judgeHeldLock(cli("laptop", 4242), never, at(LEASE + 1), HERE).kind).toBe("break");
  });

  it("another host's lock (a Cloud Shell) is held within the lease, broken after it", () => {
    expect(judgeHeldLock(cli("cs-1", 9999), never, at(LEASE), HERE).kind).toBe("held");
    const v = judgeHeldLock(cli("cs-1", 9999), never, at(LEASE + 1), HERE);
    expect(v.kind).toBe("break");
    expect(v.why).toContain("stopped renewing");
  });

  it("#815 review: a dead pid is only judged on the machine that took the lock", () => {
    const at1 = at(START.getTime() + 1);
    const withMachine = (machine: string | null) =>
      JSON.stringify({ ...JSON.parse(cli("localhost", 9999)), machine });
    const here = (machine: string | null): LocalHost => ({
      host: "localhost",
      machine,
      alive: () => false,
    });
    // Same host name, another machine (two Cloud Run containers, two
    // laptops called alike): the pid is someone else's, the lease decides.
    expect(judgeHeldLock(withMachine("m-a"), never, at1, here("m-b")).kind).toBe("held");
    // A lock from Cloud Run names no machine: never judged by its pid.
    expect(judgeHeldLock(withMachine(null), never, at1, here("m-b")).kind).toBe("held");
    // A judge in Cloud Run has no machine id: it never trusts a pid, not
    // even one of a lock written before machine ids.
    expect(judgeHeldLock(cli("localhost", 9999), never, at1, here(null)).kind).toBe("held");
    // The same machine: the dead pid ends it at once.
    expect(judgeHeldLock(withMachine("m-a"), never, at1, here("m-a")).kind).toBe("break");
    // Whatever the machine, the lease still ends it.
    expect(judgeHeldLock(withMachine("m-a"), never, at(LEASE + 1), here("m-b")).kind).toBe("break");
  });

  it("#815 review: machineId is null inside Cloud Run and stable outside", () => {
    expect(machineId({ CLOUD_RUN_EXECUTION: "caelo-upgrader-abc" })).toBeNull();
    expect(machineId({ K_SERVICE: "caelo-production-admin" })).toBeNull();
    expect(machineId({})).toBe(machineId({}));
    const body = parseLockBody(lockBody("cms-provision upgrade", START, { leaseMs: 1 }));
    expect(body && "machine" in body).toBe(true);
  });

  it("an unreadable lease is held for a person to remove", () => {
    const body = JSON.stringify({
      purpose: "cms-provision upgrade",
      host: "cs-1",
      pid: 1,
      leaseUntil: "soon",
    });
    expect(judgeHeldLock(body, never, at(LEASE + HOUR), HERE)).toMatchObject({
      kind: "held",
      manualRemoval: true,
    });
  });
});

describe("judgeHeldLock", () => {
  it("breaks the lock of an execution that has finished — succeeded, failed or cancelled", () => {
    for (const how of ["succeeded", "failed", "cancelled"]) {
      const v = judgeHeldLock(
        jobLock,
        state({ kind: "finished", how }),
        at(START.getTime() + 60_000),
      );
      expect(v.kind).toBe("break");
      expect(v.why).toContain(`has ${how}`);
    }
  });

  it("never breaks the lock of a running execution, even long past its lease", () => {
    for (const now of [START.getTime() + 1, LEASE_END + 1, LEASE_END + 24 * HOUR]) {
      const v = judgeHeldLock(jobLock, state({ kind: "running" }), at(now));
      expect(v).toMatchObject({ kind: "held", manualRemoval: false });
      expect(v.why).toContain("still running");
    }
  });

  it("an execution Cloud Run does not know: held within the lease, broken after it", () => {
    const gone = state({ kind: "not-found" });
    expect(judgeHeldLock(jobLock, gone, at(START.getTime())).kind).toBe("held");
    // Exactly at the lease's end it still holds; one millisecond later it is dead.
    expect(judgeHeldLock(jobLock, gone, at(LEASE_END)).kind).toBe("held");
    expect(judgeHeldLock(jobLock, gone, at(LEASE_END + 1)).kind).toBe("break");
  });

  it("a lock whose lease is unreadable is never broken on 'not found'", () => {
    const body = JSON.stringify({
      purpose: "caelo upgrader job",
      execution: EXEC,
      leaseUntil: "soon",
    });
    const v = judgeHeldLock(body, state({ kind: "not-found" }), at(LEASE_END + 10 * HOUR));
    expect(v).toMatchObject({ kind: "held", manualRemoval: true });
  });

  it("a holder Cloud Run cannot be asked about is undecided, never dead", () => {
    const v = judgeHeldLock(
      jobLock,
      state({ kind: "unknown", error: "PERMISSION_DENIED" }),
      at(LEASE_END + HOUR),
    );
    expect(v.kind).toBe("unknown");
    expect(v.why).toContain("PERMISSION_DENIED");
  });

  it("a pre-#815 lock (no lease) from another host is never broken automatically, and Cloud Run is not asked", () => {
    const describe = () => {
      throw new Error("must not be asked");
    };
    const cli = judgeHeldLock(
      lockBody("cms-provision upgrade", START),
      describe,
      at(START.getTime() + 100 * HOUR),
    );
    expect(cli).toMatchObject({ kind: "held", manualRemoval: true });
    const legacy = JSON.stringify({
      purpose: "caelo upgrader job",
      host: "localhost",
      pid: 1,
      startedAt: START.toISOString(),
    });
    expect(
      judgeHeldLock(legacy, describe, at(START.getTime() + 100 * HOUR), {
        host: "laptop",
        alive: () => false,
      }).kind,
    ).toBe("held");
  });

  it("an unreadable lock body is held, with the body quoted", () => {
    const v = judgeHeldLock("not json", state({ kind: "running" }), START);
    expect(v).toMatchObject({ kind: "held", manualRemoval: true });
    expect(v.why).toContain("not json");
  });
});

describe("parseExecutionState", () => {
  const exec = (status: unknown) => ok(JSON.stringify({ status }));

  it("reads the Completed condition: True succeeded, False failed or cancelled", () => {
    expect(
      parseExecutionState(exec({ conditions: [{ type: "Completed", status: "True" }] })),
    ).toEqual({
      kind: "finished",
      how: "succeeded",
    });
    expect(
      parseExecutionState(
        exec({ conditions: [{ type: "Completed", status: "False", reason: "Cancelled" }] }),
      ),
    ).toEqual({ kind: "finished", how: "cancelled" });
    expect(
      parseExecutionState(exec({ conditions: [{ type: "Completed", status: "False" }] })),
    ).toEqual({
      kind: "finished",
      how: "failed",
    });
  });

  it("a completion time without a decided condition is finished too", () => {
    expect(parseExecutionState(exec({ completionTime: "2026-10-16T11:00:00Z" })).kind).toBe(
      "finished",
    );
  });

  it("an undecided or not yet started execution is running", () => {
    expect(
      parseExecutionState(exec({ conditions: [{ type: "Completed", status: "Unknown" }] })).kind,
    ).toBe("running");
    expect(parseExecutionState(exec({})).kind).toBe("running");
    expect(parseExecutionState(ok("{}")).kind).toBe("running");
  });

  it("not found vs. any other gcloud failure", () => {
    expect(
      parseExecutionState(fail("ERROR: (gcloud.run.jobs.executions.describe) NOT_FOUND")).kind,
    ).toBe("not-found");
    expect(parseExecutionState(fail("PERMISSION_DENIED: run.executions.get"))).toEqual({
      kind: "unknown",
      error: "PERMISSION_DENIED: run.executions.get",
    });
    expect(parseExecutionState(ok("garbage")).kind).toBe("unknown");
    expect(parseExecutionState(ok(JSON.stringify({ status: { conditions: "x" } }))).kind).toBe(
      "unknown",
    );
  });
});
