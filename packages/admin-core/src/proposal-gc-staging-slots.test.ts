// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { isStagingSlotKey } from "./proposal-gc-worker.js";

describe("#1330 the staging-bucket GC keeps the staging slots", () => {
  it("treats every slot object and manifest as live, run prefixes as collectable", () => {
    for (const key of ["_slots/a/index.html", "_slots/b/_assets/x.png", "_slots/a.manifest.json"]) {
      expect(isStagingSlotKey(key)).toBe(true);
    }
    for (const key of [
      "0b7c0d6e-1111/index.html",
      "_build-files/x.json",
      "_redirect-plans/x.json",
    ]) {
      expect(isStagingSlotKey(key)).toBe(false);
    }
  });
});
