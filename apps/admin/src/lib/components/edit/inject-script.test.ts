// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { EDIT_OVERLAY_COLOR, EDIT_OVERLAY_CSS, INJECT_SCRIPT } from "./inject-script.js";

describe("edit-mode overlay stylesheet", () => {
  it("paints outline, label and banner in Caelo blue", () => {
    expect(EDIT_OVERLAY_COLOR).toBe("#2a64b8");
    expect(EDIT_OVERLAY_CSS).toContain("outline:2px solid #2a64b8");
    // Label + banner backgrounds.
    expect(EDIT_OVERLAY_CSS.match(/background:#2a64b8/g)).toHaveLength(2);
    expect(EDIT_OVERLAY_CSS).not.toContain("#3b82f6");
  });

  it("labels the hovered module 'Edit' in a mono stack, without an emoji", () => {
    expect(EDIT_OVERLAY_CSS).toContain("content:'Edit';");
    expect(EDIT_OVERLAY_CSS).toContain(
      'font:500 11px/1 "IBM Plex Mono", Menlo, Consolas, monospace;',
    );
    expect(EDIT_OVERLAY_CSS).not.toMatch(/\\u270F|✏|️/);
  });

  it("stays self-contained: no admin CSS variables leak into the operator's site", () => {
    expect(EDIT_OVERLAY_CSS).not.toContain("var(");
  });

  it("is spliced into the injected runtime as a valid JS string literal", () => {
    expect(INJECT_SCRIPT).toContain(`s.textContent = ${JSON.stringify(EDIT_OVERLAY_CSS)};`);
    // The runtime must still parse after the splice.
    expect(() => new Function(INJECT_SCRIPT)).not.toThrow();
  });
});
