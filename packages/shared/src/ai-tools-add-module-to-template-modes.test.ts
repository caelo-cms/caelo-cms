// SPDX-License-Identifier: MPL-2.0

/**
 * issue #243 — `add_module_to_template` mode gate. The schema accepts
 * exactly one of two shapes (place-existing via `moduleId`, mint via
 * `displayName` + `html`); a mixed call is ambiguous and must fail at the
 * boundary with a message naming the offending authoring fields. Mirrors
 * `ai-tools-add-module-modes.test.ts` for add_module_to_page so the two
 * fan-out tools can't drift.
 */

import { describe, expect, it } from "bun:test";
import { addModuleToTemplateToolInput } from "./ai-tools.js";

const BASE = {
  templateId: "11111111-1111-4111-8111-111111111101",
  blockName: "content",
  position: "bottom" as const,
};

describe("addModuleToTemplateToolInput modes (issue #243)", () => {
  it("accepts place mode: moduleId alone", () => {
    const r = addModuleToTemplateToolInput.safeParse({
      ...BASE,
      moduleId: "11111111-1111-4111-8111-111111111102",
    });
    expect(r.success).toBe(true);
  });

  it("accepts mint mode: displayName + html (+ fields)", () => {
    const r = addModuleToTemplateToolInput.safeParse({
      ...BASE,
      displayName: "Post footer",
      html: "<footer>{{copyright}}</footer>",
      fields: [{ name: "copyright", label: "Copyright", kind: "text" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a mixed call (moduleId + html) naming the offending fields", () => {
    const r = addModuleToTemplateToolInput.safeParse({
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
    const r = addModuleToTemplateToolInput.safeParse({ ...BASE });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("moduleId");
      expect(msg).toContain("displayName");
    }
  });

  it("rejects mint mode missing html", () => {
    const r = addModuleToTemplateToolInput.safeParse({ ...BASE, displayName: "Post footer" });
    expect(r.success).toBe(false);
  });
});
