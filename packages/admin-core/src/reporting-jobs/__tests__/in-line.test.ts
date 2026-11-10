// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — in-process attempts of one kind run one at a time, in the
 * order they came, whether the one before resolved or threw; other kinds
 * do not wait for them.
 */

import { describe, expect, it } from "bun:test";
import { createLines } from "../in-line.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createLines", () => {
  it("starts a work only after the earlier ones of its key ended, in order", async () => {
    const inLine = createLines<string>();
    const log: string[] = [];
    const work = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await wait(ms);
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      inLine("audit", work("a", 30)),
      inLine("audit", work("b", 5)),
      inLine("audit", work("c", 5)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("a work that throws does not hold the line", async () => {
    const inLine = createLines<string>();
    const failed = inLine("audit", async () => {
      throw new Error("crashed");
    });
    await expect(failed).rejects.toThrow("crashed");
    expect(await inLine("audit", async () => "next")).toBe("next");
  });

  it("another key does not wait", async () => {
    const inLine = createLines<string>();
    const log: string[] = [];
    let release!: () => void;
    const slow = inLine("audit", () =>
      new Promise<void>((r) => {
        release = r;
      }).then(() => log.push("audit")),
    );
    await inLine("crawl", async () => log.push("crawl"));
    release();
    await slow;
    expect(log).toEqual(["crawl", "audit"]);
  });
});
