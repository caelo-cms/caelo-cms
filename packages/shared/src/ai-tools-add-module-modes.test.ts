// SPDX-License-Identifier: MPL-2.0

/**
 * issue #159 + audit #2 — `add_module` mode gate. Two shapes: place-existing
 * via `moduleId`, or mint via `displayName` + `html`. A call with NEITHER
 * fails at the boundary naming both valid shapes. A `moduleId` call is
 * placement-only and TOLERATES extra authoring fields (§1A/§11 — a placement
 * that can succeed must not fail over an extra field); the tool handler, not
 * the schema, surfaces an info for any carried field that was not applied. The
 * gate is identical across every `target` (page/layout/template), so it lives
 * once on the unified schema.
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

  it("accepts mint mode: displayName + html (+ fields carrying content)", () => {
    // 2026-07 — a mint with declared fields must bring its content in
    // the same call (`values` or field defaults); bare fields would
    // render empty placeholders and are rejected.
    const r = addModuleToolInput.safeParse({
      ...BASE,
      displayName: "Hero",
      html: "<h1>{{hero_title}}</h1>",
      fields: [{ name: "hero_title", label: "Hero title", kind: "text" }],
      values: { hero_title: "Welcome" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects mint mode with fields but neither values nor defaults (empty placeholders)", () => {
    const r = addModuleToolInput.safeParse({
      ...BASE,
      displayName: "Hero",
      html: "<h1>{{hero_title}}</h1>",
      fields: [{ name: "hero_title", label: "Hero title", kind: "text" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain("initial content");
    }
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

  it("TOLERATES a moduleId call carrying authoring keys (incl. structural html) — placement-only, handler surfaces the ignored-authoring info", () => {
    // §1A/§11 — a valid placement must never fail over an extra authoring
    // field. moduleId + html passes; the tool handler (not the schema)
    // reports that html was not applied and points at edit_module.
    const r = addModuleToolInput.safeParse({
      ...BASE,
      moduleId: "11111111-1111-4111-8111-111111111102",
      html: "<p>hi</p>",
    });
    expect(r.success).toBe(true);
  });

  it("TOLERATES moduleId + metadata (displayName) — a harmless redundant label on a reuse", () => {
    const r = addModuleToolInput.safeParse({
      ...BASE,
      moduleId: "11111111-1111-4111-8111-111111111102",
      displayName: "Site Header",
    });
    expect(r.success).toBe(true);
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
