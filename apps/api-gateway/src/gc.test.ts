// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway sweeps its own state from the request handler, at most once
 * per interval: it gets CPU only while a request runs, so a timer could not
 * be relied on.
 */

import { describe, expect, it } from "bun:test";
import { dueSweeper } from "./gc.js";

describe("dueSweeper", () => {
  it("runs on the first request, then not again until the interval passed", async () => {
    let clock = 0;
    let runs = 0;
    const sweepIfDue = dueSweeper(
      async () => {
        runs++;
      },
      1000,
      () => clock,
    );
    await sweepIfDue();
    expect(runs).toBe(1);
    clock = 999;
    await sweepIfDue();
    expect(runs).toBe(1);
    clock = 1000;
    await sweepIfDue();
    expect(runs).toBe(2);
  });

  it("lets concurrent requests through while one request's sweep runs", async () => {
    let release = (): void => undefined;
    let runs = 0;
    const sweepIfDue = dueSweeper(
      () =>
        new Promise<void>((resolve) => {
          runs++;
          release = resolve;
        }),
      1000,
      () => 0,
    );
    const first = sweepIfDue();
    await sweepIfDue();
    expect(runs).toBe(1);
    release();
    await first;
  });

  it("logs a failed sweep instead of failing the request, and retries after the interval", async () => {
    let clock = 0;
    let runs = 0;
    const sweepIfDue = dueSweeper(
      async () => {
        runs++;
        throw new Error("db down");
      },
      1000,
      () => clock,
    );
    await expect(sweepIfDue()).resolves.toBeUndefined();
    clock = 1000;
    await sweepIfDue();
    expect(runs).toBe(2);
  });
});
