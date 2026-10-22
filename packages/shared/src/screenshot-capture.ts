// SPDX-License-Identifier: MPL-2.0

/**
 * The operator-browser `screenshot_page` capture (html2canvas in the chat
 * panel) and the tool handler that receives its result agree on one failure
 * kind: the capture target exists but has no rendered size.
 *
 * Why it needs its own kind: the browser capture renders the preview WITHOUT
 * the page's scripts (#946 — the frame shares the admin origin, so scripts
 * must not run with the operator's session). An element a script reveals —
 * the consent banner is `display:none` until the consent runtime adds a class
 * to `<html>` — is therefore 0×0 there, html2canvas paints a 0×0 canvas and
 * `canvas.toBlob` answers null (e2e-livedit 2026-10, "canvas.toBlob returned
 * null" on `[data-consent-banner]`). That is a limit of this backend, not of
 * the page: the server-side renderer runs real Chromium with scripts and can
 * capture the element, so the handler routes such a failure there.
 */

/** Prefix of a browser-capture failure whose target has no rendered size. */
export const SCREENSHOT_TARGET_NOT_RENDERED = "capture target is not rendered";

/** A rendered box, as `getBoundingClientRect()` / a canvas reports it. */
export interface ScreenshotBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The failure message when the capture target (or the canvas painted from
 * it) has no area, else null.
 *
 * @param target - what is being captured: the selector, or "page body".
 */
export function screenshotTargetNotRendered(target: string, box: ScreenshotBox): string | null {
  if (box.width > 0 && box.height > 0) return null;
  return (
    `${SCREENSHOT_TARGET_NOT_RENDERED}: ${target} is ${Math.round(box.width)}×${Math.round(box.height)}px ` +
    "in the operator-browser capture, which runs without the page's scripts — an element a script " +
    "reveals (display:none until then) has no size there"
  );
}

/** True when a browser-capture failure message is the not-rendered kind. */
export function isScreenshotTargetNotRendered(message: string): boolean {
  return message.includes(SCREENSHOT_TARGET_NOT_RENDERED);
}
