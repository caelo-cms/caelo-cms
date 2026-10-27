// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { floatingRect, isCompactOverlay, overlayPositionStyle } from "./overlay-position.js";
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

  // The phone report: Float (four arrows) drew the chat at the desktop
  // position and size, off the right edge of a 390 px screen.
  it("keeps a floating overlay on screen", () => {
    const phone = { width: 390, height: 844 };
    const desk = { width: 1440, height: 900 };
    const floating = { ...LAYOUT, pin: "floating" as const, x: 900, y: 700 };
    expect(
      overlayPositionStyle(floating, { docked: false, chromeBottom: 44, viewport: desk }),
    ).toBe("left: 900px; top: 340px; width: 400px; height: 560px;");
    // A window narrower than the stored x: pulled back so the whole box shows.
    expect(
      overlayPositionStyle(floating, {
        docked: false,
        chromeBottom: 44,
        viewport: { width: 1000, height: 700 },
      }),
    ).toBe("left: 600px; top: 140px; width: 400px; height: 560px;");
    // Phones never float: the overlay is the full-width surface under the toolbar.
    expect(
      overlayPositionStyle(floating, { docked: false, chromeBottom: 44, viewport: phone }),
    ).toBe("left: 0; right: 0; top: 44px; bottom: 0;");
  });

  it("narrows pinned modes to the viewport", () => {
    const vp = { width: 800, height: 400 };
    expect(
      overlayPositionStyle(
        { ...LAYOUT, pinnedWidth: 900 },
        { docked: false, chromeBottom: 44, viewport: vp },
      ),
    ).toBe("right: 0; top: 56px; bottom: 0; width: 800px;");
    expect(
      overlayPositionStyle(
        { ...LAYOUT, pin: "pinned-bottom", pinnedHeight: 600 },
        { docked: false, chromeBottom: 44, viewport: vp },
      ),
    ).toBe("left: 0; right: 0; bottom: 0; height: 356px;");
  });

  it("is compact below the md breakpoint only, and never before the first measure", () => {
    expect(isCompactOverlay(undefined)).toBe(false);
    expect(isCompactOverlay({ width: 390, height: 844 })).toBe(true);
    expect(isCompactOverlay({ width: 767, height: 1024 })).toBe(true);
    expect(isCompactOverlay({ width: 768, height: 1024 })).toBe(false);
  });

  // PR #1166 review: a drag starts from the drawn (clamped) rectangle.
  it("floatingRect is the drawn rectangle the drag starts from", () => {
    const stored = { x: 900, y: 80, width: 400, height: 560 };
    expect(floatingRect(stored, { width: 1000, height: 900 })).toEqual({
      x: 600,
      y: 80,
      width: 400,
      height: 560,
    });
    expect(floatingRect(stored, undefined)).toEqual(stored);
  });
});
