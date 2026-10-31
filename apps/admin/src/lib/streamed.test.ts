// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createLane, settle } from "./streamed.js";

describe("settle (#1268)", () => {
  it("resolves a step's value", async () => {
    expect(await settle("Pages", async () => [1, 2])).toEqual({ ok: true, value: [1, 2] });
  });

  it("turns a thrown error into a named failure instead of rejecting", async () => {
    const r = await settle("Other open chats", async () => {
      throw new Error("canceling statement due to statement timeout");
    });
    expect(r).toEqual({
      ok: false,
      error: "Other open chats could not be loaded: canceling statement due to statement timeout",
    });
  });

  it("tells the observer each step's name, duration and outcome", async () => {
    const seen: [string, boolean][] = [];
    const observe = (step: string, ms: number, ok: boolean) => {
      expect(ms).toBeGreaterThanOrEqual(0);
      seen.push([step, ok]);
    };
    await settle("A", async () => 1, observe);
    await settle("B", async () => Promise.reject(new Error("x")), observe);
    expect(seen).toEqual([
      ["A", true],
      ["B", false],
    ]);
  });
});

describe("createLane (#1268)", () => {
  it("runs steps one after another, each with its own result", async () => {
    const lane = createLane();
    const order: string[] = [];
    let releaseFirst = () => {};
    const first = lane(
      () =>
        new Promise<string>((resolve) => {
          order.push("first started");
          releaseFirst = () => resolve("a");
        }),
    );
    const second = lane(async () => {
      order.push("second started");
      return "b";
    });
    await Promise.resolve();
    expect(order).toEqual(["first started"]);
    releaseFirst();
    expect(await first).toBe("a");
    expect(await second).toBe("b");
    expect(order).toEqual(["first started", "second started"]);
  });

  it("runs the next step after a failed one", async () => {
    const lane = createLane();
    const failed = lane(async () => {
      throw new Error("boom");
    });
    const next = lane(async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ran");
  });
});
