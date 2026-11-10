// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — one attempt: the lease is renewed while the main works and
 * not a moment longer; a stop from the admin ends it as `stopped`; on
 * another version the job defers instead of reporting with a protocol the
 * admin may not have.
 */

import { describe, expect, it } from "bun:test";
import { runOrder } from "../job-entry.js";
import { createJobReporter, JobStoppedError, type ReportTransport } from "../job-reporter.js";
import type { JobOrder, ReportEnvelope } from "../protocol.js";
import { runJobAttempt } from "../run-job.js";

const ORDER: JobOrder = {
  version: "0.12.0",
  kind: "quality_audit",
  subjectId: "00000000-0000-4000-8000-000000001359",
  attempt: 1,
  token: "t".repeat(43),
};

function recording(answer: unknown = {}): ReportTransport & { sent: ReportEnvelope[] } {
  const sent: ReportEnvelope[] = [];
  return {
    label: "test",
    sent,
    async send(envelope) {
      sent.push(envelope);
      return { status: 200, answer: { ok: true, value: answer } };
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runJobAttempt", () => {
  it("renews the lease while the main works, and stops renewing when it returns", async () => {
    const t = recording();
    const reporter = createJobReporter(ORDER, t);
    const outcome = await runJobAttempt(reporter, () => wait(80), 15);
    expect(outcome).toBe("completed");
    const beats = t.sent.filter((e) => e.action === "heartbeat").length;
    expect(beats).toBeGreaterThanOrEqual(2);
    await wait(60);
    expect(t.sent.filter((e) => e.action === "heartbeat").length).toBe(beats);
  });

  it("ends as stopped when the admin ended the attempt", async () => {
    const reporter = createJobReporter(ORDER, recording());
    const outcome = await runJobAttempt(
      reporter,
      async () => {
        throw new JobStoppedError("stale", "a newer attempt replaced this one");
      },
      1000,
    );
    expect(outcome).toBe("stopped");
  });

  it("lets any other failure through: the attempt died, the backstop restarts it", async () => {
    const t = recording();
    const reporter = createJobReporter(ORDER, t);
    await expect(
      runJobAttempt(
        reporter,
        async () => {
          throw new Error("out of memory");
        },
        5,
      ),
    ).rejects.toThrow("out of memory");
    await wait(30);
    expect(t.sent.filter((e) => e.action === "heartbeat")).toHaveLength(0);
  });
});

describe("runOrder", () => {
  it("defers to the next attempt when the job's image lags the admin", async () => {
    const t = recording();
    let ran = false;
    const outcome = await runOrder(ORDER, t, {
      version: "0.11.9",
      main: async () => {
        ran = true;
      },
    });
    expect(outcome).toBe("deferred");
    expect(ran).toBe(false);
    expect(t.sent).toHaveLength(1);
    const deferral = t.sent[0] as ReportEnvelope;
    expect(deferral.action).toBe("defer");
    expect((deferral.payload as { reason: string }).reason).toContain("0.11.9");
  });

  it("runs the kind's main on the admin's own version", async () => {
    const t = recording();
    const outcome = await runOrder(ORDER, t, {
      version: "0.12.0",
      main: async (r) => {
        await r.call("start");
      },
    });
    expect(outcome).toBe("completed");
    expect(t.sent.map((e) => e.action)).toEqual(["start"]);
  });
});
