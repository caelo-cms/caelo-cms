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
 * Below this viewport width (Tailwind's `md`) the chat is one full-width
 * surface under the toolbar: a 420 px column or a 400 px floating box does
 * not fit a phone, and the move / pin / resize gestures it would need are
 * desktop gestures.
 */
export const COMPACT_OVERLAY_MAX_WIDTH = 768;

/** The viewport the overlay is placed in, once the browser has measured it. */
export interface OverlayViewport {
  readonly width: number;
  readonly height: number;
}

/** True when the overlay renders as the full-width phone surface. */
export function isCompactOverlay(viewport: OverlayViewport | undefined): boolean {
  return viewport !== undefined && viewport.width < COMPACT_OVERLAY_MAX_WIDTH;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Inline position style for the overlay.
 *
 * With a measured `viewport` every mode stays on screen: the stored layout
 * is the operator's preference from whatever screen they last used, and a
 * floating box saved at x=900 on a desktop rendered entirely off a 390 px
 * phone — the chat "vanished" after the Float (four-arrows) control, with
 * its own controls out of reach. The stored layout is left as is; only
 * where it is drawn is clamped.
 *
 * @param chromeBottom px from the viewport top to the bottom of the page
 *   chrome (banner + toolbar), as measured by the /edit page.
 * @param viewport the window size; absent before the first browser measure.
 */
export function overlayPositionStyle(
  layout: OverlayLayout,
  opts: { docked: boolean; chromeBottom: number; viewport?: OverlayViewport },
): string {
  if (opts.docked) return "position:relative; inset:auto; width:100%; height:100%;";
  if (layout.collapsed) return "right: 24px; bottom: 24px; width: 56px; height: 56px;";
  const vp = opts.viewport;
  if (isCompactOverlay(vp)) {
    return `left: 0; right: 0; top: ${opts.chromeBottom}px; bottom: 0;`;
  }
  if (layout.pin === "pinned-bottom") {
    const height = vp
      ? clamp(layout.pinnedHeight, 0, vp.height - opts.chromeBottom)
      : layout.pinnedHeight;
    return `left: 0; right: 0; bottom: 0; height: ${height}px;`;
  }
  if (layout.pin === "pinned-right") {
    const top = opts.chromeBottom + PINNED_RIGHT_GAP_PX;
    const width = vp ? Math.min(layout.pinnedWidth, vp.width) : layout.pinnedWidth;
    return `right: 0; top: ${top}px; bottom: 0; width: ${width}px;`;
  }
  if (!vp) {
    return `left: ${layout.x}px; top: ${layout.y}px; width: ${layout.width}px; height: ${layout.height}px;`;
  }
  const width = Math.min(layout.width, vp.width);
  const height = Math.min(layout.height, vp.height);
  const x = clamp(layout.x, 0, vp.width - width);
  const y = clamp(layout.y, 0, vp.height - height);
  return `left: ${x}px; top: ${y}px; width: ${width}px; height: ${height}px;`;
}
