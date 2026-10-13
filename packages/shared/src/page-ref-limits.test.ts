// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #690 — page references in module tools may be full URL paths; a
 * six-level path of 64-char slugs (~390 chars) must pass validation.
 */

import { describe, expect, it } from "bun:test";
import { removeModuleFromToolInput } from "./ai-tools.js";

describe("page reference length", () => {
  it("accepts a maximal nested page path as targetRef", () => {
    const seg = "a".repeat(64);
    const path = `/${Array.from({ length: 6 }, () => seg).join("/")}`;
    expect(path.length).toBeGreaterThan(200);
    const r = removeModuleFromToolInput.safeParse({
      target: "page",
      targetRef: path,
      moduleId: "00000000-0000-4000-8000-000000000001",
    });
    expect(r.success).toBe(true);
  });
});
