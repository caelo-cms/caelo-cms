// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describeLoadTiming, timedStep, withLoadTiming } from "./load-timing.js";

describe("plugin load timing (#1633)", () => {
  it("adds up each step of one load attempt, in the order the steps first ran", async () => {
    const { value, steps } = await withLoadTiming(async () => {
      await timedStep("register", () => Bun.sleep(5));
      await timedStep("provision", () => Bun.sleep(5));
      await timedStep("provision", () => Bun.sleep(5));
      return timedStep("skills", () => 42);
    });
    expect(value).toBe(42);
    expect([...steps.keys()]).toEqual(["register", "provision", "skills"]);
    expect(steps.get("provision") ?? 0).toBeGreaterThanOrEqual(steps.get("register") ?? 0);
  });

  it("keeps two loads running side by side apart", async () => {
    const [a, b] = await Promise.all([
      withLoadTiming(() => timedStep("register", () => Bun.sleep(1))),
      withLoadTiming(() => timedStep("activate", () => Bun.sleep(1))),
    ]);
    expect([...a.steps.keys()]).toEqual(["register"]);
    expect([...b.steps.keys()]).toEqual(["activate"]);
  });

  it("times a step that throws, and outside a load just runs it", async () => {
    let steps: ReadonlyMap<string, number> = new Map();
    await withLoadTiming(async () => {
      await timedStep("register", () => Promise.reject(new Error("boom"))).catch(() => undefined);
    }).then((r) => {
      steps = r.steps;
    });
    expect([...steps.keys()]).toEqual(["register"]);
    expect(await timedStep("verify", () => "ran")).toBe("ran");
  });

  it("names the plugin, the total and every step in seconds", () => {
    const line = describeLoadTiming(
      "consent-manager",
      113_249,
      new Map([
        ["register", 2_104],
        ["activation lease", 40],
      ]),
    );
    expect(line).toBe("consent-manager loaded in 113.2 s (register 2.1 s, activation lease 0.0 s)");
    expect(describeLoadTiming("comments", 80, new Map())).toBe("comments loaded in 0.1 s");
  });
});
