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
  lockBody,
  parseExecutionState,
  parseLockBody,
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

  it("a CLI lock carries neither", () => {
    const body = parseLockBody(lockBody("cms-provision upgrade", START));
    expect(body?.purpose).toBe("cms-provision upgrade");
    expect(body?.execution).toBeUndefined();
    expect(body?.leaseUntil).toBeUndefined();
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

  it("a CLI or pre-#815 lock is never broken automatically, and Cloud Run is not asked", () => {
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
    expect(judgeHeldLock(legacy, describe, at(START.getTime() + 100 * HOUR)).kind).toBe("held");
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
