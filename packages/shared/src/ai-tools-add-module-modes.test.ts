// SPDX-License-Identifier: MPL-2.0

/**
 * issue #159 — `add_module_to_page` mode gate. The schema accepts
 * exactly one of two shapes (place-existing via `moduleId`, mint via
 * `displayName` + `html`); a mixed call is ambiguous and must fail at
 * the boundary with a message naming both valid shapes.
 */

import { describe, expect, it } from "bun:test";
import { addModuleToPageToolInput } from "./ai-tools.js";

const BASE = {
  pageId: "11111111-1111-4111-8111-111111111101",
  blockName: "content",
  position: "bottom" as const,
};

describe("addModuleToPageToolInput modes (issue #159)", () => {
  it("accepts place mode: moduleId alone", () => {
    const r = addModuleToPageToolInput.safeParse({
      ...BASE,
      moduleId: "11111111-1111-4111-8111-111111111102",
    });
    expect(r.success).toBe(true);
  });

  it("accepts mint mode: displayName + html (+ fields)", () => {
    const r = addModuleToPageToolInput.safeParse({
      ...BASE,
      displayName: "Hero",
      html: "<h1>{{hero_title}}</h1>",
      fields: [{ name: "hero_title", label: "Hero title", kind: "text" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a mixed call (moduleId + html) naming the offending fields", () => {
    const r = addModuleToPageToolInput.safeParse({
      ...BASE,
      moduleId: "11111111-1111-4111-8111-111111111102",
      html: "<p>hi</p>",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("html");
      expect(msg).toContain("edit_module");
    }
  });

  it("rejects a call with neither mode, pointing at both valid shapes", () => {
    const r = addModuleToPageToolInput.safeParse({ ...BASE });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("moduleId");
      expect(msg).toContain("displayName");
    }
  });

  it("rejects mint mode missing html", () => {
    const r = addModuleToPageToolInput.safeParse({ ...BASE, displayName: "Hero" });
    expect(r.success).toBe(false);
  });
});
