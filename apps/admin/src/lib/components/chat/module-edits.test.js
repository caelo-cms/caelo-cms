// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { moduleHtmlEdits } from "./module-edits.js";
describe("moduleHtmlEdits", () => {
    it("returns one edit per update_modules_many item that carries html", () => {
        expect(moduleHtmlEdits("update_modules_many", {
            items: [
                { moduleId: "m1", html: "<p>a</p>" },
                { moduleId: "m2", css: ".x{}" },
                { moduleId: "m3", html: "<p>c</p>" },
            ],
        })).toEqual([
            { moduleId: "m1", html: "<p>a</p>" },
            { moduleId: "m3", html: "<p>c</p>" },
        ]);
    });
    it("reads the pre-merge `updates` wrapper key from history", () => {
        expect(moduleHtmlEdits("update_modules_many", { updates: [{ moduleId: "m1", html: "<p>a</p>" }] })).toEqual([{ moduleId: "m1", html: "<p>a</p>" }]);
    });
    it("reads a retired edit_module call from history", () => {
        expect(moduleHtmlEdits("edit_module", { moduleId: "m1", html: "<p>a</p>" })).toEqual([
            { moduleId: "m1", html: "<p>a</p>" },
        ]);
        expect(moduleHtmlEdits("edit_module", { moduleId: "m1", css: ".x{}" })).toEqual([]);
    });
    it("ignores other tools and malformed arguments", () => {
        expect(moduleHtmlEdits("add_module", { moduleId: "m1", html: "<p>a</p>" })).toEqual([]);
        expect(moduleHtmlEdits("update_modules_many", null)).toEqual([]);
        expect(moduleHtmlEdits("update_modules_many", { items: "nope" })).toEqual([]);
        expect(moduleHtmlEdits("update_modules_many", { items: [null, 3] })).toEqual([]);
    });
});
