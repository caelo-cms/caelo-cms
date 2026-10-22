// SPDX-License-Identifier: MPL-2.0

/**
 * Viewport resolution for the operator-browser `screenshot_page` capture.
 *
 * Why the live preview wins for desktop: "desktop" is not one width. A fixed
 * 1280px capture iframe showed the AI a hero headline on 3 lines while the
 * operator's ~1740px-wide preview wrapped it onto 4 (module type sizes use
 * `clamp(…, Nvw, …)`, so wider viewports grow the font while the text column
 * stays capped). The AI then "fixed" a layout it could not see. Capturing at
 * the operator's live preview size makes the AI see what the operator sees;
 * an explicit `width` lets it check other desktop widths on purpose.
 */

type ScreenshotViewportName = "desktop" | "tablet" | "mobile";

/** Where the capture size came from — reported back to the AI as fact. */
type ScreenshotViewportSource = "operator-preview" | "requested" | "preset";

/** Preset sizes, mirrored by the server-side renderer (`PREVIEW_SCREENSHOT_VIEWPORTS`). */
const SCREENSHOT_VIEWPORT_PRESETS: Record<
  ScreenshotViewportName,
  { width: number; height: number }
> = {
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
export function resolveScreenshotViewport(args: {
  viewport: ScreenshotViewportName;
  width?: number;
  livePreview: { width: number; height: number } | null;
}): { width: number; height: number; source: ScreenshotViewportSource } {
  const preset = SCREENSHOT_VIEWPORT_PRESETS[args.viewport];
  if (args.width !== undefined) {
    return { width: args.width, height: preset.height, source: "requested" };
  }
  if (
    args.viewport === "desktop" &&
    args.livePreview !== null &&
    args.livePreview.width > 0 &&
    args.livePreview.height > 0
  ) {
    return {
      width: Math.round(args.livePreview.width),
      height: Math.round(args.livePreview.height),
      source: "operator-preview",
    };
  }
  return { ...preset, source: "preset" };
}

/** Client size of the first visible live preview iframe in `doc`, or null. */
export function measureLivePreview(doc: Document): { width: number; height: number } | null {
  const el = doc.querySelector<HTMLIFrameElement>(`iframe[${LIVE_PREVIEW_ATTRIBUTE}]`);
  if (!el || el.clientWidth === 0 || el.clientHeight === 0) return null;
  return { width: el.clientWidth, height: el.clientHeight };
}
