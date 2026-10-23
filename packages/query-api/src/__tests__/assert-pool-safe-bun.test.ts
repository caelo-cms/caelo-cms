// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for `assertPoolSafeBun` (adapter.ts): before Bun 1.4.4 the
 * pool's idle timeout also closed connections in the middle of a
 * transaction, so the adapter must refuse to start on an older Bun.
 */

import { describe, expect, it } from "bun:test";
import { assertPoolSafeBun, MIN_BUN_VERSION } from "../adapter.js";

describe("assertPoolSafeBun", () => {
  it("accepts the minimum version and anything newer", () => {
    for (const v of [MIN_BUN_VERSION, "1.4.5", "1.5.0", "2.0.0", "1.4.4-canary.3"]) {
      expect(() => assertPoolSafeBun(v)).not.toThrow();
    }
  });

  it("refuses the Bun releases whose idle timeout ends running transactions", () => {
    for (const v of ["1.4.3", "1.4.2", "1.3.13", "0"]) {
      expect(() => assertPoolSafeBun(v)).toThrow(/needs Bun >= 1\.4\.4/);
    }
  });

  it("the running test Bun satisfies it", () => {
    expect(() => assertPoolSafeBun(Bun.version)).not.toThrow();
  });
});
