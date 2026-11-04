// SPDX-License-Identifier: MPL-2.0
/**
 * Regression: `screenshot_page` captured desktop in a fixed 1280px iframe
 * while the operator's live preview was ~1740px wide. Headlines sized with
 * `vw` wrapped onto 4 lines for the operator and 3 for the AI, so the AI
 * could not see — let alone fix — the break the operator reported.
 */
import { describe, expect, it } from "bun:test";
import { resolveScreenshotViewport } from "./screenshot-viewport.js";
const LIVE = { width: 1743, height: 980 };
describe("resolveScreenshotViewport", () => {
    it("captures desktop at the operator's live preview size", () => {
        expect(resolveScreenshotViewport({ viewport: "desktop", livePreview: LIVE })).toEqual({
            width: 1743,
            height: 980,
            source: "operator-preview",
        });
    });
    it("lets an explicit width win over the live preview", () => {
        expect(resolveScreenshotViewport({ viewport: "desktop", width: 1280, livePreview: LIVE })).toEqual({ width: 1280, height: 800, source: "requested" });
    });
    it("keeps tablet and mobile on their presets", () => {
        expect(resolveScreenshotViewport({ viewport: "mobile", livePreview: LIVE })).toEqual({
            width: 375,
            height: 812,
            source: "preset",
        });
        expect(resolveScreenshotViewport({ viewport: "tablet", livePreview: LIVE })).toEqual({
            width: 768,
            height: 1024,
            source: "preset",
        });
    });
    it("uses the desktop preset when no live preview is visible", () => {
        expect(resolveScreenshotViewport({ viewport: "desktop", livePreview: null })).toEqual({
            width: 1280,
            height: 800,
            source: "preset",
        });
        expect(resolveScreenshotViewport({ viewport: "desktop", livePreview: { width: 0, height: 0 } })).toEqual({ width: 1280, height: 800, source: "preset" });
    });
});
