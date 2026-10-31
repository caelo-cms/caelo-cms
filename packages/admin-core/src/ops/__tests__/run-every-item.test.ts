// SPDX-License-Identifier: MPL-2.0

/**
 * `runEveryItem` (#1277): every failing index is reported, and an item that
 * ABORTED (threw `OperationAbortError`, which an op does only after its
 * first write) counts as written, so the caller rolls the batch back
 * instead of committing a half-written failed item (Codex review, PR #1280).
 */

import { describe, expect, it } from "bun:test";
import { OperationAbortError, type QueryError } from "@caelo-cms/query-api";
import { runEveryItem } from "../_bulk.js";

const refused = (message: string): QueryError => ({
  kind: "HandlerError",
  operation: "t",
  message,
});

describe("runEveryItem", () => {
  it("reports every failing index and counts only successes when items returned errors", async () => {
    const run = await runEveryItem("t.many", "items", [1, 2, 3], async (n) =>
      n === 2
        ? { ok: true as const, value: n }
        : { ok: false as const, error: refused(`bad ${n}`) },
    );
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.writtenItems).toBe(1);
    const paths = ((run.error as { errors?: { path: unknown[] }[] }).errors ?? []).map(
      (e) => e.path,
    );
    expect(paths).toEqual([
      ["items", 0],
      ["items", 2],
    ]);
  });

  it("counts an aborted item as written even when no item succeeded", async () => {
    const run = await runEveryItem("t.many", "items", [1, 2], async (n) => {
      if (n === 1) throw new OperationAbortError(refused("wrote, then failed"));
      return { ok: false as const, error: refused("before any write") };
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.writtenItems).toBe(1);
  });
});
