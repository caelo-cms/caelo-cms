// SPDX-License-Identifier: MPL-2.0

/**
 * #1390 — the in-process aggregate of a plugin's core operation calls and
 * its change consumer's backoff, which the runtime heartbeat writes.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  OTHER_OPS,
  pluginRuntimeStats,
  recordPluginOpCall,
  resetPluginRuntimeStats,
  setConsumerBackoff,
  timedPluginOpCall,
} from "./plugin-runtime-stats.js";

afterEach(() => resetPluginRuntimeStats());

function statsOf(slug: string) {
  const s = pluginRuntimeStats().find((x) => x.slug === slug);
  if (!s) throw new Error(`no stats for ${slug}`);
  return s;
}

describe("plugin runtime stats", () => {
  it("counts calls, total and longest time per plugin and operation", () => {
    recordPluginOpCall("consent", "content_instances.list", 60_000.4);
    recordPluginOpCall("consent", "content_instances.list", 1_200);
    recordPluginOpCall("consent", "modules.get", 3);
    recordPluginOpCall("other", "modules.get", 5);
    expect(statsOf("consent").opCost).toEqual({
      "content_instances.list": { calls: 2, totalMs: 61_200, maxMs: 60_000 },
      "modules.get": { calls: 1, totalMs: 3, maxMs: 3 },
    });
    expect(statsOf("other").opCost).toEqual({ "modules.get": { calls: 1, totalMs: 5, maxMs: 5 } });
    expect(statsOf("consent").consumerBackoff).toBeNull();
  });

  it("counts a call that throws as well, and passes its result or error through", async () => {
    expect(await timedPluginOpCall("p", "a.op", async () => 42)).toBe(42);
    await expect(
      timedPluginOpCall("p", "a.op", async () => {
        throw new Error("statement timeout");
      }),
    ).rejects.toThrow("statement timeout");
    expect(statsOf("p").opCost["a.op"]?.calls).toBe(2);
  });

  it("bounds the operation names a plugin can make it keep", () => {
    for (let i = 0; i < 150; i++) recordPluginOpCall("p", `made.up_${i}`, 1);
    const ops = statsOf("p").opCost;
    expect(Object.keys(ops).length).toBe(101);
    expect(ops[OTHER_OPS]?.calls).toBe(50);
  });

  it("returns a copy: later calls do not change a snapshot already taken", () => {
    recordPluginOpCall("p", "a.op", 1);
    const before = statsOf("p");
    recordPluginOpCall("p", "a.op", 1);
    expect(before.opCost["a.op"]?.calls).toBe(1);
  });

  it("keeps a cleared backoff as null so the heartbeat overwrites the written one", () => {
    setConsumerBackoff("p", {
      consecutiveFailures: 2,
      nextRetryAt: "2026-11-03T10:00:02.000Z",
      lastError: "boom",
    });
    expect(statsOf("p").consumerBackoff?.consecutiveFailures).toBe(2);
    setConsumerBackoff("p", null);
    expect(statsOf("p").consumerBackoff).toBeNull();
    // Clearing a plugin that never backed off adds nothing to report.
    setConsumerBackoff("never", null);
    expect(pluginRuntimeStats().some((s) => s.slug === "never")).toBe(false);
  });
});
