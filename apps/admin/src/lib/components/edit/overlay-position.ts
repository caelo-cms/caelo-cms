// SPDX-License-Identifier: MPL-2.0

/**
 * Where the live-edit chat overlay sits for each pin mode.
 *
 * The pinned-right column starts below the /edit page chrome. That chrome is
 * not a fixed height: the cross-chat banner ("Also pending: …") appears above
 * the toolbar whenever other chats hold pending changes. A hard-coded top
 * (the old `top: 56px`) let the column, which stacks above the toolbar,
 * cover the toolbar's right-hand controls — "Edit elements", Diff, the page
 * picker — so they could not be clicked while the banner showed (the
 * live-edit-modifier-click E2E flake: parallel specs leave pending chats, the
 * banner appears, the toggle click never lands).
 */

import type { OverlayLayout } from "./use-overlay-layout.svelte.js";

/** Gap between the bottom of the page chrome and the pinned-right column. */
const PINNED_RIGHT_GAP_PX = 12;

/**
 * Inline position style for the overlay.
 *
 * @param chromeBottom px from the viewport top to the bottom of the page
 *   chrome (banner + toolbar), as measured by the /edit page.
 */
export function overlayPositionStyle(
  layout: OverlayLayout,
  opts: { docked: boolean; chromeBottom: number },
): string {
  if (opts.docked) return "position:relative; inset:auto; width:100%; height:100%;";
  if (layout.collapsed) return "right: 24px; bottom: 24px; width: 56px; height: 56px;";
  if (layout.pin === "pinned-bottom") {
    return `left: 0; right: 0; bottom: 0; height: ${layout.pinnedHeight}px;`;
  }
  if (layout.pin === "pinned-right") {
    const top = opts.chromeBottom + PINNED_RIGHT_GAP_PX;
    return `right: 0; top: ${top}px; bottom: 0; width: ${layout.pinnedWidth}px;`;
  }
  return `left: ${layout.x}px; top: ${layout.y}px; width: ${layout.width}px; height: ${layout.height}px;`;
}
