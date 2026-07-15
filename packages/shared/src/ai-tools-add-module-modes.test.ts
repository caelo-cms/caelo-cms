// SPDX-License-Identifier: MPL-2.0

/**
 * issue #159 + audit #2 — `add_module` mode gate. The schema accepts exactly
 * one of two shapes (place-existing via `moduleId`, mint via `displayName` +
 * `html`); a mixed call is ambiguous and must fail at the boundary with a
 * message naming both valid shapes. The gate is identical across every
 * `target` (page/layout/template), so it lives once on the unified schema.
 */

import { describe, expect, it } from "bun:test";
import { addModuleToolInput } from "./ai-tools.js";

const BASE = {
  target: "page" as const,
  targetRef: "11111111-1111-4111-8111-111111111101",
  blockName: "content",
  position: "bottom" as const,
};

describe("addModuleToolInput modes (issue #159)", () => {
  it("accepts place mode: moduleId alone", () => {
    const r = addModuleToolInput.safeParse({
      ...BASE,
      moduleId: "11111111-1111-4111-8111-111111111102",
    });
    expect(r.success).toBe(true);
  });

  it("accepts mint mode: displayName + html (+ fields)", () => {
    const r = addModuleToolInput.safeParse({
      ...BASE,
      displayName: "Hero",
      html: "<h1>{{hero_title}}</h1>",
      fields: [{ name: "hero_title", label: "Hero title", kind: "text" }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts place mode against a layout target too", () => {
    const r = addModuleToolInput.safeParse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: "bottom",
      moduleId: "11111111-1111-4111-8111-111111111102",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a mixed call (moduleId + html) naming the offending fields", () => {
    const r = addModuleToolInput.safeParse({
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
    const r = addModuleToolInput.safeParse({ ...BASE });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("moduleId");
      expect(msg).toContain("displayName");
    }
  });

  it("rejects mint mode missing html", () => {
    const r = addModuleToolInput.safeParse({ ...BASE, displayName: "Hero" });
    expect(r.success).toBe(false);
  });
});
