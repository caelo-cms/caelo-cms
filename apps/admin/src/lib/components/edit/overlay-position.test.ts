// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { overlayPositionStyle } from "./overlay-position.js";
import type { OverlayLayout } from "./use-overlay-layout.svelte.js";

const LAYOUT: OverlayLayout = {
  pin: "pinned-right",
  collapsed: false,
  x: 24,
  y: 80,
  width: 400,
  height: 560,
  pinnedHeight: 320,
  pinnedWidth: 420,
};

describe("overlayPositionStyle", () => {
  it("starts the pinned-right column just below the toolbar", () => {
    // No banner: 44 px toolbar + 12 px gap — the position it always had.
    expect(overlayPositionStyle(LAYOUT, { docked: false, chromeBottom: 44 })).toBe(
      "right: 0; top: 56px; bottom: 0; width: 420px;",
    );
  });

  it("moves the column down when the cross-chat banner pushes the toolbar down", () => {
    // Regression: with the banner (36 px) the column stayed at top 56 px and
    // covered the toolbar's "Edit elements" toggle (toolbar bottom at 80 px).
    const style = overlayPositionStyle(LAYOUT, { docked: false, chromeBottom: 80 });
    expect(style).toBe("right: 0; top: 92px; bottom: 0; width: 420px;");
  });

  it("leaves the other modes alone", () => {
    expect(
      overlayPositionStyle(
        { ...LAYOUT, pin: "pinned-bottom" },
        { docked: false, chromeBottom: 80 },
      ),
    ).toBe("left: 0; right: 0; bottom: 0; height: 320px;");
    expect(
      overlayPositionStyle({ ...LAYOUT, pin: "floating" }, { docked: false, chromeBottom: 80 }),
    ).toBe("left: 24px; top: 80px; width: 400px; height: 560px;");
    expect(
      overlayPositionStyle({ ...LAYOUT, collapsed: true }, { docked: false, chromeBottom: 80 }),
    ).toBe("right: 24px; bottom: 24px; width: 56px; height: 56px;");
    expect(overlayPositionStyle(LAYOUT, { docked: true, chromeBottom: 80 })).toBe(
      "position:relative; inset:auto; width:100%; height:100%;",
    );
  });
});
