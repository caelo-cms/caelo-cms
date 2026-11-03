// SPDX-License-Identifier: MPL-2.0

/**
 * #1140 — the self-hosted Pulumi stack and the CLI render the same Compose
 * file, so the scheduler interval `init` recorded survives a `pulumi up`,
 * and a disagreeing Pulumi key is refused instead of winning silently.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordedSchedulerIntervalMinutes,
  selfHostedSchedulerIntervalMinutes,
} from "./self-hosted-scheduler-interval.js";

const dir = mkdtempSync(join(tmpdir(), "caelo-scheduler-interval-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function config(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("recordedSchedulerIntervalMinutes", () => {
  it("reads what init recorded", () => {
    expect(
      recordedSchedulerIntervalMinutes(config("a.json", '{"schedulerIntervalMinutes":2}')),
    ).toBe(2);
  });

  it("is undefined without a config.json or without the key", () => {
    expect(recordedSchedulerIntervalMinutes(join(dir, "missing.json"))).toBeUndefined();
    expect(recordedSchedulerIntervalMinutes(config("b.json", '{"domain":"x"}'))).toBeUndefined();
  });

  it("refuses a broken file or an out-of-range value", () => {
    expect(() => recordedSchedulerIntervalMinutes(config("c.json", "{"))).toThrow("not valid JSON");
    expect(() =>
      recordedSchedulerIntervalMinutes(config("d.json", '{"schedulerIntervalMinutes":30}')),
    ).toThrow("between 1 and 15");
    expect(() =>
      recordedSchedulerIntervalMinutes(config("e.json", '{"schedulerIntervalMinutes":"2"}')),
    ).toThrow("not a number");
  });
});

describe("selfHostedSchedulerIntervalMinutes", () => {
  it("keeps the recorded interval when the Pulumi key is unset", () => {
    expect(selfHostedSchedulerIntervalMinutes(undefined, 2, "config.json")).toBe(2);
    expect(selfHostedSchedulerIntervalMinutes(undefined, undefined, "config.json")).toBeUndefined();
  });

  it("takes the Pulumi key on a Pulumi-only install, or when both agree", () => {
    expect(selfHostedSchedulerIntervalMinutes(3, undefined, "config.json")).toBe(3);
    expect(selfHostedSchedulerIntervalMinutes(2, 2, "config.json")).toBe(2);
  });

  it("refuses a Pulumi key that disagrees with the record", () => {
    expect(() => selfHostedSchedulerIntervalMinutes(5, 2, "config.json")).toThrow(
      "config.json records 2",
    );
  });
});
