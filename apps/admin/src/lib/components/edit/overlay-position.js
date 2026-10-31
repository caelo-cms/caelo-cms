// SPDX-License-Identifier: MPL-2.0
/** Gap between the bottom of the page chrome and the pinned-right column. */
const PINNED_RIGHT_GAP_PX = 12;
/**
 * Below this viewport width (Tailwind's `md`) the chat is one full-width
 * surface under the toolbar: a 420 px column or a 400 px floating box does
 * not fit a phone, and the move / pin / resize gestures it would need are
 * desktop gestures.
 */
export const COMPACT_OVERLAY_MAX_WIDTH = 768;
/** True when the overlay renders as the full-width phone surface. */
export function isCompactOverlay(viewport) {
    return viewport !== undefined && viewport.width < COMPACT_OVERLAY_MAX_WIDTH;
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
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
export function overlayPositionStyle(layout, opts) {
    if (opts.docked)
        return "position:relative; inset:auto; width:100%; height:100%;";
    if (layout.collapsed)
        return "right: 24px; bottom: 24px; width: 56px; height: 56px;";
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
    const r = floatingRect(layout, vp);
    return `left: ${r.x}px; top: ${r.y}px; width: ${r.width}px; height: ${r.height}px;`;
}
/**
 * Where a floating overlay is drawn: the stored position and size, pulled
 * inside the viewport when it is known. A drag starts from (and stores)
 * this rectangle, so a box drawn back on screen moves from where the
 * operator sees it rather than from its off-screen stored position.
 */
export function floatingRect(layout, viewport) {
    if (!viewport)
        return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
    const width = Math.min(layout.width, viewport.width);
    const height = Math.min(layout.height, viewport.height);
    return {
        x: clamp(layout.x, 0, viewport.width - width),
        y: clamp(layout.y, 0, viewport.height - height),
        width,
        height,
    };
}
