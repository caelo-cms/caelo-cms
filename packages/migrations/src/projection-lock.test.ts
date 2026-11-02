// SPDX-License-Identifier: MPL-2.0

/**
 * The projection lock never makes a publisher wait inside a transaction
 * (2026-11-02 incident): a busy lock ends the attempt's transaction, and
 * the publisher asks again in a new one after a pause, until its deadline.
 */

import { describe, expect, it } from "bun:test";
import {
  ProjectionBusyError,
  type ProjectionDatabases,
  withProjectionLock,
} from "./public-projection.js";

/** Fake databases: the lock answers from `answers`, one per attempt. */
function fakeDbs(answers: boolean[]) {
  const log: string[] = [];
  let open = 0;
  const dbs: ProjectionDatabases = {
    readAdmin: async (fn) => {
      open += 1;
      log.push(`begin(open=${open})`);
      try {
        return await fn({
          execute: async () => [{ locked: answers.shift() ?? false }],
        });
      } finally {
        open -= 1;
        log.push("end");
      }
    },
    writePublic: async () => {
      throw new Error("not used");
    },
  };
  return { dbs, log };
}

function clock() {
  let t = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => t,
    sleep: async (ms: number) => {
      // Every pause happens with no transaction open (asserted by callers).
      pauses.push(ms);
      t += ms;
    },
  };
}

describe("withProjectionLock", () => {
  it("runs the work at once when the lock is free", async () => {
    const { dbs, log } = fakeDbs([true]);
    const c = clock();
    const value = await withProjectionLock(dbs, c, async () => "done");
    expect(value).toBe("done");
    expect(log).toEqual(["begin(open=1)", "end"]);
    expect(c.pauses).toEqual([]);
  });

  it("ends its transaction while another publisher holds the lock, then asks again", async () => {
    const { dbs, log } = fakeDbs([false, false, true]);
    const c = clock();
    const value = await withProjectionLock(dbs, { ...c, retryMs: 200 }, async () => 42);
    expect(value).toBe(42);
    // Three separate transactions, never two open at once, none held during a pause.
    expect(log).toEqual(["begin(open=1)", "end", "begin(open=1)", "end", "begin(open=1)", "end"]);
    expect(c.pauses.length).toBe(2);
    for (const p of c.pauses) {
      expect(p).toBeGreaterThanOrEqual(100);
      expect(p).toBeLessThanOrEqual(300);
    }
  });

  it("gives up with ProjectionBusyError once the wait is over, without running the work", async () => {
    const { dbs } = fakeDbs([]);
    const c = clock();
    let ran = false;
    const attempt = withProjectionLock(dbs, { ...c, waitMs: 1_000, retryMs: 200 }, async () => {
      ran = true;
    });
    await expect(attempt).rejects.toBeInstanceOf(ProjectionBusyError);
    expect(ran).toBe(false);
    // The last pause is cut to the deadline, never past it.
    expect(c.pauses.reduce((a, b) => a + b, 0)).toBeCloseTo(1_000, 6);
  });
});
