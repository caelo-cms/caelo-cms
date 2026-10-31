// SPDX-License-Identifier: MPL-2.0
/**
 * The admin's `<head>` icons (app.html) name files that exist in static/,
 * and the admin ships no web manifest: behind IAP the manifest fetch is
 * redirected to Google's sign-in and fails with a CORS error on every page
 * load (v0.2.55), so the manifest was dropped instead of fixed.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const ADMIN_ROOT = resolve(import.meta.dir, "..");
const ASSETS = "%sveltekit.assets%/";
const appHtml = readFileSync(resolve(ADMIN_ROOT, "src/app.html"), "utf8");
const links = [...appHtml.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
function attr(tag, name) {
    return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}
describe("app.html head icons", () => {
    const icons = links.filter((tag) => (attr(tag, "rel") ?? "").includes("icon"));
    it("declares the favicon and the touch icon", () => {
        expect(icons.map((tag) => attr(tag, "rel"))).toEqual(["icon", "apple-touch-icon"]);
    });
    for (const tag of icons) {
        const href = attr(tag, "href") ?? "";
        it(`${href} resolves to a file in static/`, () => {
            expect(href.startsWith(ASSETS)).toBe(true);
            expect(existsSync(resolve(ADMIN_ROOT, "static", href.slice(ASSETS.length)))).toBe(true);
        });
    }
    it("serves the touch icon as PNG (iOS ignores SVG touch icons)", () => {
        const touch = icons.find((tag) => attr(tag, "rel") === "apple-touch-icon") ?? "";
        expect(attr(touch, "href")?.endsWith(".png")).toBe(true);
    });
    it("links no web manifest and ships none", () => {
        expect(links.some((tag) => attr(tag, "rel") === "manifest")).toBe(false);
        expect(existsSync(resolve(ADMIN_ROOT, "static/manifest.json"))).toBe(false);
    });
});
