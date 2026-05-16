// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.2 — `positionInputSchema` coercion test. The AI recurrently
 * passes JSON-quoted numbers (`"0"`, `"42"`) to the `position` field
 * on the three `add_module_to_*` tools even though the tool
 * description says to use bare integers. The schema now coerces
 * digit-only strings; non-numeric strings still fail cleanly.
 *
 * Pins the contract so a future "harden the validator" pass doesn't
 * silently re-introduce the AI-facing schema-rejection that v0.6.2
 * fixed.
 */

import { describe, expect, it } from "bun:test";

import {
  addModuleToLayoutToolInput,
  addModuleToPageToolInput,
  addModuleToTemplateToolInput,
  positionInputSchema,
} from "./ai-tools.js";

const UUID = "11111111-1111-4111-8111-aaaaaaaaaaaa";

describe("positionInputSchema (v0.6.2)", () => {
  it("accepts literal 'top' / 'bottom'", () => {
    expect(positionInputSchema.safeParse("top").success).toBe(true);
    expect(positionInputSchema.safeParse("bottom").success).toBe(true);
  });

  it("accepts bare integers (0..1000)", () => {
    expect(positionInputSchema.safeParse(0).success).toBe(true);
    expect(positionInputSchema.safeParse(42).success).toBe(true);
    expect(positionInputSchema.safeParse(1000).success).toBe(true);
  });

  it("coerces digit-only strings to integers (the v0.6.2 ergonomic fix)", () => {
    const r0 = positionInputSchema.safeParse("0");
    expect(r0.success).toBe(true);
    if (r0.success) expect(r0.data).toBe(0);

    const r42 = positionInputSchema.safeParse("42");
    expect(r42.success).toBe(true);
    if (r42.success) expect(r42.data).toBe(42);
  });

  it("rejects non-numeric strings (not 'top'/'bottom')", () => {
    expect(positionInputSchema.safeParse("middle").success).toBe(false);
    expect(positionInputSchema.safeParse("abc").success).toBe(false);
    expect(positionInputSchema.safeParse("").success).toBe(false);
  });

  it("rejects negative + over-range integers", () => {
    expect(positionInputSchema.safeParse(-1).success).toBe(false);
    expect(positionInputSchema.safeParse(1001).success).toBe(false);
    expect(positionInputSchema.safeParse("-1").success).toBe(false);
  });

  it("rejects floats + scientific notation strings", () => {
    expect(positionInputSchema.safeParse(0.5).success).toBe(false);
    expect(positionInputSchema.safeParse("0.5").success).toBe(false);
    expect(positionInputSchema.safeParse("1e2").success).toBe(false);
  });

  it("propagates to addModuleToPageToolInput", () => {
    const r = addModuleToPageToolInput.safeParse({
      pageId: UUID,
      blockName: "content",
      position: "0", // the AI's typical mistake
      displayName: "x",
      html: "<p>x</p>",
    });
    expect(r.success).toBe(true);
  });

  it("propagates to addModuleToTemplateToolInput", () => {
    const r = addModuleToTemplateToolInput.safeParse({
      templateId: UUID,
      blockName: "content",
      position: "3",
      displayName: "x",
      html: "<p>x</p>",
    });
    expect(r.success).toBe(true);
  });

  it("propagates to addModuleToLayoutToolInput", () => {
    const r = addModuleToLayoutToolInput.safeParse({
      layoutSlug: "site-default",
      blockName: "header",
      position: "0",
      displayName: "x",
      html: "<p>x</p>",
    });
    expect(r.success).toBe(true);
  });
});
