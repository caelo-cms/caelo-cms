// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { promptText, splitToolbarSlots } from "./plugin-toolbar.js";
describe("splitToolbarSlots", () => {
    it("shows up to three places", () => {
        expect(splitToolbarSlots(["a", "b", "c"])).toEqual({ shown: ["a", "b", "c"], more: [] });
    });
    it("from four on, shows two and moves the rest behind +N", () => {
        expect(splitToolbarSlots(["a", "b", "c", "d"])).toEqual({
            shown: ["a", "b"],
            more: ["c", "d"],
        });
    });
});
describe("promptText", () => {
    it("puts the shown page's path in for {page}", () => {
        expect(promptText("Translate {page} now; {page} only.", "/de/preise")).toBe("Translate /de/preise now; /de/preise only.");
    });
});
