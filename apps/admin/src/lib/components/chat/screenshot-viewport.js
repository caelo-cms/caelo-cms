// SPDX-License-Identifier: MPL-2.0
/** Preset sizes, mirrored by the server-side renderer (`PREVIEW_SCREENSHOT_VIEWPORTS`). */
const SCREENSHOT_VIEWPORT_PRESETS = {
    desktop: { width: 1280, height: 800 },
    tablet: { width: 768, height: 1024 },
    mobile: { width: 375, height: 812 },
};
/** Marks the operator's live preview iframe so the capture can measure it. */
const LIVE_PREVIEW_ATTRIBUTE = "data-caelo-live-preview";
/**
 * Pick the capture size: an explicit `width` wins (the AI asked for a
 * specific breakpoint), then — for desktop only — the operator's visible
 * live preview, then the preset. Tablet/mobile stay on their presets: the
 * operator's preview is a desktop-sized pane, so measuring it would defeat
 * the point of asking for a narrow viewport.
 *
 * @param livePreview client size of the live preview iframe, or null when
 *   none is mounted/visible (chat page with the preview hidden, etc.).
 */
export function resolveScreenshotViewport(args) {
    const preset = SCREENSHOT_VIEWPORT_PRESETS[args.viewport];
    if (args.width !== undefined) {
        return { width: args.width, height: preset.height, source: "requested" };
    }
    if (args.viewport === "desktop" &&
        args.livePreview !== null &&
        args.livePreview.width > 0 &&
        args.livePreview.height > 0) {
        return {
            width: Math.round(args.livePreview.width),
            height: Math.round(args.livePreview.height),
            source: "operator-preview",
        };
    }
    return { ...preset, source: "preset" };
}
/** Client size of the first visible live preview iframe in `doc`, or null. */
export function measureLivePreview(doc) {
    const el = doc.querySelector(`iframe[${LIVE_PREVIEW_ATTRIBUTE}]`);
    if (!el || el.clientWidth === 0 || el.clientHeight === 0)
        return null;
    return { width: el.clientWidth, height: el.clientHeight };
}
