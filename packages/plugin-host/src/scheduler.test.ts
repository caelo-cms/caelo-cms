// SPDX-License-Identifier: MPL-2.0

/**
 * #1720 — one worker whose cron croner refuses stays off the schedule and is
 * returned for the loader to record; the plugin's other workers register.
 * Pure: the dispatcher is a stub, nothing runs.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { runPluginOperation } from "./dispatch.js";
import { pluginWorkerScheduler } from "./scheduler.js";

const dispatch = (async () => ({ ok: true, value: null })) as unknown as typeof runPluginOperation;
const SLUG = "test-1720-workers";

function schedule(workers: { name: string; cron: string }[]) {
  return pluginWorkerScheduler.schedule({
    pluginSlug: SLUG,
    workers: workers.map((w) => ({ ...w, operationName: "sweep" })),
    dispatch,
    pluginActorId: "00000000-0000-0000-0000-000000001720",
  });
}

const names = () =>
  pluginWorkerScheduler
    .list()
    .filter((w) => w.pluginSlug === SLUG)
    .map((w) => w.workerName);

afterEach(() => pluginWorkerScheduler.unschedulePlugin(SLUG));

describe("pluginWorkerScheduler.schedule (#1720)", () => {
  it("registers the other workers when one cron does not parse, and returns that one", () => {
    const unscheduled = schedule([
      { name: "hourly", cron: "0 * * * *" },
      { name: "broken", cron: "0 0 * * SUN6" },
      { name: "nightly", cron: "17 3 * * *" },
    ]);
    expect(names()).toEqual(["hourly", "nightly"]);
    expect(unscheduled).toHaveLength(1);
    expect(unscheduled[0]).toMatchObject({ workerName: "broken", cron: "0 0 * * SUN6" });
    expect(unscheduled[0]?.reason).toContain("CronPattern");
  });

  it("keeps a registered worker's next occurrence working", () => {
    schedule([
      { name: "broken", cron: "61 * * * *" },
      { name: "hourly", cron: "0 * * * *" },
    ]);
    const hourly = pluginWorkerScheduler.list().find((w) => w.pluginSlug === SLUG);
    expect(hourly?.nextAfter(new Date("2026-11-25T10:20:00Z"))?.toISOString()).toBe(
      "2026-11-25T11:00:00.000Z",
    );
  });

  it("registers nothing, and throws nothing, when every cron is refused", () => {
    const unscheduled = schedule([
      { name: "a", cron: "61 * * * *" },
      { name: "b", cron: "garbage" },
    ]);
    expect(names()).toEqual([]);
    expect(unscheduled.map((w) => w.workerName)).toEqual(["a", "b"]);
  });

  it("returns nothing when every worker registers, and a reload replaces the workers", () => {
    expect(schedule([{ name: "a", cron: "0 * * * *" }])).toEqual([]);
    schedule([
      { name: "b", cron: "61 * * * *" },
      { name: "c", cron: "*/5 * * * *" },
    ]);
    expect(names()).toEqual(["c"]);
  });
});

describe("pluginWorkerScheduler.unscheduled (#1728)", () => {
  const off = () => pluginWorkerScheduler.unscheduled(SLUG).map((w) => w.workerName);

  it("keeps the workers off the schedule until the plugin is scheduled again", () => {
    schedule([
      { name: "hourly", cron: "0 * * * *" },
      { name: "weekly_digest", cron: "0 0 * * SUN6" },
    ]);
    expect(off()).toEqual(["weekly_digest"]);
    expect(pluginWorkerScheduler.unscheduled(SLUG)[0]).toMatchObject({
      cron: "0 0 * * SUN6",
      reason: expect.stringContaining("CronPattern"),
    });
    // Asking again does not consume it: health reads it on every heartbeat.
    expect(off()).toEqual(["weekly_digest"]);
  });

  it("a reload with the cron fixed clears it", () => {
    schedule([{ name: "weekly_digest", cron: "0 0 * * SUN6" }]);
    schedule([{ name: "weekly_digest", cron: "0 0 * * SUN" }]);
    expect(off()).toEqual([]);
    expect(names()).toEqual(["weekly_digest"]);
  });

  it("a reload without workers, an uninstall and a host shutdown clear it", () => {
    schedule([{ name: "a", cron: "61 * * * *" }]);
    schedule([]);
    expect(off()).toEqual([]);
    schedule([{ name: "a", cron: "61 * * * *" }]);
    pluginWorkerScheduler.unschedulePlugin(SLUG);
    expect(off()).toEqual([]);
    schedule([{ name: "a", cron: "61 * * * *" }]);
    pluginWorkerScheduler.shutdown();
    expect(off()).toEqual([]);
  });

  it("is per plugin, and a copy the caller cannot change", () => {
    schedule([{ name: "a", cron: "61 * * * *" }]);
    expect(pluginWorkerScheduler.unscheduled("test-1728-other")).toEqual([]);
    const list = pluginWorkerScheduler.unscheduled(SLUG) as unknown as unknown[];
    list.length = 0;
    expect(off()).toEqual(["a"]);
  });
});
