// SPDX-License-Identifier: MPL-2.0

/** The estimate the Stage status and the Publish live gate give for a Stage's search index. */

import { describe, expect, it } from "bun:test";
import { summarizeIndexProgress } from "./progress.js";

const at = (s: number) => new Date(Date.UTC(2026, 10, 26, 10, 0, s)).toISOString();

describe("summarizeIndexProgress", () => {
  it("adds up the tasks and estimates from their joint pace", () => {
    const p = {
      startedAt: at(0),
      at: at(50),
      tasks: { "0": { embedded: 300, toEmbed: 1_000 }, "1": { embedded: 200, toEmbed: 1_000 } },
    };
    // 500 in 50 s; 1,500 left take 150 s, of which 10 s passed since the last report.
    expect(summarizeIndexProgress(p, Date.parse(at(60)))).toEqual({
      embedded: 500,
      toEmbed: 2_000,
      tasks: 2,
      remainingMs: 140_000,
    });
  });

  it("takes the plan's total and task count, so tasks that have not reported still count", () => {
    const p = {
      startedAt: at(0),
      at: at(30),
      planned: 3_000,
      taskCount: 3,
      tasks: { "0": { embedded: 1_000, toEmbed: 1_000 } },
    };
    expect(summarizeIndexProgress(p, Date.parse(at(30)))).toMatchObject({
      embedded: 1_000,
      toEmbed: 3_000,
      tasks: 3,
      remainingMs: 60_000,
    });
  });

  it("gives no time before a pace can be measured, and nothing for no progress", () => {
    const first = { startedAt: at(0), at: at(0), tasks: { "0": { embedded: 0, toEmbed: 9 } } };
    expect(summarizeIndexProgress(first, Date.parse(at(1)))?.remainingMs).toBeNull();
    expect(summarizeIndexProgress(null, 0)).toBeNull();
    expect(summarizeIndexProgress({ startedAt: at(0), at: at(1), tasks: {} }, 0)).toBeNull();
    expect(summarizeIndexProgress({ unexpected: true }, 0)).toBeNull();
  });
});
