// SPDX-License-Identifier: MPL-2.0

/**
 * #1213 — the per-render-pass memo: shared within one pass, never across
 * passes, never outside a render, and a failed read is not replayed.
 */

import { describe, expect, it } from "bun:test";
import { BatchMemo, batchIn, onceIn, renderMemoOf } from "./render-memo.js";

const pass = (renderId: string) => ({ invocation: { origin: "render", actorId: "s", renderId } });

describe("renderMemoOf", () => {
  it("shares one memo per pass and none outside a render pass", () => {
    const a = crypto.randomUUID();
    expect(renderMemoOf(pass(a))).toBe(renderMemoOf(pass(a)));
    expect(renderMemoOf(pass(a))).not.toBe(renderMemoOf(pass(crypto.randomUUID())));
    // No render id, or not a render: a throwaway memo per call.
    const tool = { invocation: { origin: "chat", actorId: "s", renderId: a } };
    expect(renderMemoOf(tool)).not.toBe(renderMemoOf(tool));
    const build = { invocation: { origin: "render", actorId: "s" } };
    expect(renderMemoOf(build)).not.toBe(renderMemoOf(build));
  });

  it("reads a pass value once, and again after a failed read", async () => {
    const memo = renderMemoOf(pass(crypto.randomUUID()));
    let reads = 0;
    const load = async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient");
      return reads;
    };
    await expect(onceIn(memo, "x", load)).rejects.toThrow("transient");
    expect(await onceIn(memo, "x", load)).toBe(2);
    expect(await onceIn(memo, "x", load)).toBe(2);
    expect(reads).toBe(2);
  });
});

describe("BatchMemo", () => {
  it("loads only the keys not loaded yet, in one batch, with `absent` for unanswered keys", async () => {
    const memo = new BatchMemo<string | null>();
    const batches: string[][] = [];
    const load = async (missing: string[]) => {
      batches.push(missing);
      return new Map(missing.filter((k) => k !== "none").map((k) => [k, k.toUpperCase()]));
    };
    expect([...(await memo.getMany(["a", "b", "a"], load, null))]).toEqual([
      ["a", "A"],
      ["b", "B"],
    ]);
    expect([...(await memo.getMany(["b", "c", "none"], load, null))]).toEqual([
      ["b", "B"],
      ["c", "C"],
      ["none", null],
    ]);
    expect(batches).toEqual([
      ["a", "b"],
      ["c", "none"],
    ]);
  });

  it("forgets a failed batch so the next call reads again", async () => {
    const memo = batchIn<number>(renderMemoOf(pass(crypto.randomUUID())), "n");
    let calls = 0;
    const load = async (missing: string[]) => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return new Map(missing.map((k) => [k, k.length]));
    };
    await expect(memo.getMany(["aa", "b"], load, 0)).rejects.toThrow("down");
    expect([...(await memo.getMany(["aa", "b"], load, 0))]).toEqual([
      ["aa", 2],
      ["b", 1],
    ]);
    expect(calls).toBe(2);
  });
});
