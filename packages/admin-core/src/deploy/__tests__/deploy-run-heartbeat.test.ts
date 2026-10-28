// SPDX-License-Identifier: MPL-2.0

/**
 * #1211 — the heartbeat of a Stage aborts the run only on what a beat
 * learned about the leases the run held when that beat started.
 */

import { describe, expect, it } from "bun:test";
import { type DeployRunBeat, DeployRunHeartbeat } from "../deploy-run-lock.js";

/** A beat whose answer the test hands over when it chooses. */
function deferredBeats(): {
  beat: () => Promise<DeployRunBeat>;
  started: () => number;
  answer: (r: DeployRunBeat) => void;
} {
  const pending: ((r: DeployRunBeat) => void)[] = [];
  let count = 0;
  return {
    beat: () =>
      new Promise<DeployRunBeat>((resolve) => {
        count++;
        pending.push(resolve);
      }),
    started: () => count,
    answer: (r) => pending.shift()?.(r),
  };
}

async function untilStarted(beats: { started: () => number }, n: number): Promise<void> {
  for (let i = 0; i < 200 && beats.started() < n; i++) await Bun.sleep(5);
  expect(beats.started()).toBeGreaterThanOrEqual(n);
}

describe("DeployRunHeartbeat", () => {
  it("a beat started before the publication lease was acquired cannot abort the run", async () => {
    const beats = deferredBeats();
    const heartbeat = new DeployRunHeartbeat(beats.beat, 10);
    try {
      await untilStarted(beats, 1);
      // The run acquires the lease while that beat is still in flight …
      heartbeat.expectPublication(true);
      // … and the beat answers with what it saw before the acquisition.
      beats.answer({ running: true, publication: "not-held" });
      await Bun.sleep(20);
      expect(heartbeat.lost.aborted).toBe(false);
    } finally {
      beats.answer({ running: true, publication: "renewed" });
      await heartbeat.stop();
    }
  });

  it("a beat started while the lease was held aborts the run when the lease lapsed", async () => {
    const beats = deferredBeats();
    const heartbeat = new DeployRunHeartbeat(beats.beat, 10);
    heartbeat.expectPublication(true);
    try {
      await untilStarted(beats, 1);
      beats.answer({ running: true, publication: "lost" });
      await Bun.sleep(20);
      expect(heartbeat.lost.aborted).toBe(true);
    } finally {
      beats.answer({ running: true, publication: "renewed" });
      await heartbeat.stop();
    }
  });

  it("a run marked failed aborts whatever the beat expected", async () => {
    const beats = deferredBeats();
    const heartbeat = new DeployRunHeartbeat(beats.beat, 10);
    try {
      await untilStarted(beats, 1);
      beats.answer({ running: false, publication: "not-held" });
      await Bun.sleep(20);
      expect(heartbeat.lost.aborted).toBe(true);
    } finally {
      beats.answer({ running: true, publication: "renewed" });
      await heartbeat.stop();
    }
  });
});
