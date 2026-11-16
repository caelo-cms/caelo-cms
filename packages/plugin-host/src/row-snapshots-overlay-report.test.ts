// SPDX-License-Identifier: MPL-2.0

/**
 * #1625 — a branch holding many pending rows of one table is reported
 * once per branch and table, with the branch, so the log names where every
 * read of that table pays for all of them.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { LARGE_BRANCH_OVERLAY_ROWS, reportLargeOverlay } from "./row-snapshots.js";

const BRANCH = "30000000-0000-4000-8000-000000000001";
const PLUGIN = "40000000-0000-4000-8000-000000000001";
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

test("reports a large whole-table overlay once per branch and table", () => {
  const input = { pluginId: PLUGIN, table: "value_hosts", chatBranchId: BRANCH };
  reportLargeOverlay(input, LARGE_BRANCH_OVERLAY_ROWS + 1, 12.4);
  reportLargeOverlay(input, LARGE_BRANCH_OVERLAY_ROWS + 1, 30);
  expect(warn).toHaveBeenCalledTimes(1);
  const message = String(warn.mock.calls[0]?.[0]);
  expect(message).toContain(BRANCH);
  expect(message).toContain("value_hosts");
  expect(message).toContain(`${LARGE_BRANCH_OVERLAY_ROWS + 1} pending rows`);
  // Another table of the same branch is its own report.
  reportLargeOverlay({ ...input, table: "module_guards" }, LARGE_BRANCH_OVERLAY_ROWS + 1, 1);
  expect(warn).toHaveBeenCalledTimes(2);
});

test("stays quiet for small overlays and for reads of named rows", () => {
  const input = { pluginId: PLUGIN, table: "settings", chatBranchId: BRANCH };
  reportLargeOverlay(input, LARGE_BRANCH_OVERLAY_ROWS, 1);
  reportLargeOverlay({ ...input, rowIds: ["x"] }, LARGE_BRANCH_OVERLAY_ROWS + 100, 1);
  expect(warn).not.toHaveBeenCalled();
});
