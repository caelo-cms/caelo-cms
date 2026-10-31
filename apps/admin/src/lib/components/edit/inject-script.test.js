// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { chatChipSchema } from "@caelo-cms/shared";
import { EDIT_AFFORDANCES_SCRIPT, EDIT_OVERLAY_COLOR, EDIT_UI_CSS, REFERENCE_LIMITS, } from "./edit-affordances-script.js";
import { INJECT_SCRIPT } from "./inject-script.js";
describe("edit affordance UI (#916)", () => {
    it("paints in Caelo blue and stays self-contained", () => {
        expect(EDIT_OVERLAY_COLOR).toBe("#2a64b8");
        expect(EDIT_UI_CSS).toContain("outline:2px solid #2a64b8");
        // No admin tokens: the stylesheet lives inside the operator's site.
        expect(EDIT_UI_CSS).not.toContain("var(");
    });
    it("never styles the site's own elements", () => {
        // The old edit mode forced position:relative on the hovered module and
        // drew a pill + banner over the site's navigation. Everything now sits
        // in a shadow root; no selector may reach module roots or body.
        expect(INJECT_SCRIPT).not.toContain("caelo-edit-mode");
        expect(INJECT_SCRIPT).not.toContain("[data-caelo-module-id]{");
        expect(EDIT_AFFORDANCES_SCRIPT).toContain('attachShadow({ mode: "open" })');
        expect(EDIT_UI_CSS).not.toContain("position:relative");
    });
    it("never carries an AI instruction out of the preview", () => {
        // The preview runs the site's module scripts, which can post the same
        // messages as this runtime. Ask AI therefore only flags the reference
        // (`ask`); the instruction is typed and sent in the editor's composer.
        expect(EDIT_AFFORDANCES_SCRIPT).toContain("msg.ask = true");
        expect(EDIT_AFFORDANCES_SCRIPT).not.toContain("prompt");
        expect(EDIT_AFFORDANCES_SCRIPT).not.toContain('createElement("input")');
    });
    it("is spliced into the injected runtime, which still parses", () => {
        expect(INJECT_SCRIPT).toContain(EDIT_AFFORDANCES_SCRIPT);
        expect(() => new Function(INJECT_SCRIPT)).not.toThrow();
    });
    it("has exactly one way out to the editor (#946)", () => {
        // The spliced scripts share one function scope: a second declaration
        // with the same name would silently replace the channel-carrying sender.
        expect(INJECT_SCRIPT.match(/function postToEditor\(/g)).toHaveLength(1);
        expect(INJECT_SCRIPT.match(/parent\.postMessage\(/g)).toHaveLength(1);
        // Nothing reads the editor's window: the preview is cross-origin to it.
        expect(INJECT_SCRIPT).not.toContain("parent.location");
        expect(INJECT_SCRIPT).not.toContain("parent.document");
        expect(INJECT_SCRIPT).not.toContain("location.reload(");
        expect(INJECT_SCRIPT).not.toContain("location.assign(");
    });
    it("clips references to exactly what the chat endpoint accepts", () => {
        const at = (n) => "a".repeat(n);
        const chip = (over) => chatChipSchema.safeParse({
            moduleId: "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7",
            selector: "h1",
            label: "h1",
            ...over,
        }).success;
        for (const key of ["label", "selector", "selectedText", "context"]) {
            expect(chip({ [key]: at(REFERENCE_LIMITS[key]) })).toBe(true);
            expect(chip({ [key]: at(REFERENCE_LIMITS[key] + 1) })).toBe(false);
        }
    });
});
const CHANNEL = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";
/**
 * Runs the injected runtime against a minimal fake DOM and returns the
 * browse-mode click handler plus what it did: the navigate requests it
 * posted to the editor, and any navigation it tried itself.
 */
function bootRuntime(search = `?branch=b1&channel=${CHANNEL}`) {
    // Every listener per kind, like the DOM: the editing affordances add
    // click listeners of their own next to the browse-mode one.
    const listeners = new Map();
    const assigned = [];
    const posted = [];
    const document = {
        readyState: "loading",
        addEventListener: (kind, fn) => listeners.set(kind, [...(listeners.get(kind) ?? []), fn]),
        getElementById: () => null,
        createElement: () => ({}),
        head: { appendChild: () => undefined },
        body: { classList: { contains: () => false, add: () => undefined, remove: () => undefined } },
    };
    const location = {
        href: `https://admin.example/edit/preview-by-path/about${search}`,
        origin: "https://admin.example",
        search,
        assign: (u) => assigned.push(u),
        reload: () => undefined,
    };
    const win = { addEventListener: () => undefined };
    const parent = {
        postMessage: (msg, target) => {
            expect(target).toBe("https://admin.example");
            posted.push(msg);
        },
    };
    new Function("window", "document", "location", "parent", INJECT_SCRIPT)(win, document, location, parent);
    const clickListeners = listeners.get("click") ?? [];
    if (clickListeners.length === 0)
        throw new Error("runtime registered no click handler");
    const handler = (ev) => {
        for (const fn of clickListeners)
            fn(ev);
    };
    return {
        click(href) {
            const a = { nodeType: 1, tagName: "A", target: "", getAttribute: () => href };
            let defaultPrevented = false;
            handler({
                target: a,
                preventDefault: () => {
                    defaultPrevented = true;
                },
            });
            const navigate = posted
                .filter((m) => m.kind === "caelo:navigate")
                .map((m) => {
                expect(m.channel).toBe(CHANNEL);
                return m.href ?? "";
            });
            return { defaultPrevented, assigned: [...assigned], navigate };
        },
        clickElement(target) {
            const before = posted.length;
            let defaultPrevented = false;
            handler({
                target,
                preventDefault: () => {
                    defaultPrevented = true;
                },
            });
            return { defaultPrevented, posted: posted.slice(before) };
        },
    };
}
describe("an editor notice's Ask AI button", () => {
    it("adds the module it stands in for to the chat, with the notice as context", () => {
        const notice = {
            nodeType: 1,
            tagName: "DIV",
            id: "",
            className: "",
            textContent: "Hidden from visitors: loads from cdn.example.com Resolve in chat",
            parentNode: null,
            hasAttribute: (a) => a === "data-caelo-module-id",
            getAttribute: (a) => ({ "data-caelo-module-id": "m-header", "aria-label": "site-header" })[a] ?? null,
        };
        const button = {
            nodeType: 1,
            tagName: "BUTTON",
            id: "",
            className: "",
            textContent: "Resolve in chat",
            parentNode: notice,
            hasAttribute: () => false,
            getAttribute: () => null,
        };
        button.closest = (sel) => (sel === "[data-caelo-ask-ai]" ? button : null);
        const r = bootRuntime().clickElement(button);
        expect(r.defaultPrevented).toBe(true);
        expect(r.posted).toEqual([
            {
                kind: "caelo:element-referenced",
                moduleId: "m-header",
                selector: "div",
                label: "site-header",
                context: "Hidden from visitors: loads from cdn.example.com",
                ask: true,
                channel: CHANNEL,
            },
        ]);
    });
});
describe("browse-mode link clicks (#724)", () => {
    it("swallows a click on an unresolved caelo: reference instead of navigating", () => {
        const r = bootRuntime().click("caelo:page/33333333-3333-4333-8333-333333333333");
        expect(r.defaultPrevented).toBe(true);
        expect(r.assigned).toEqual([]);
        expect(r.navigate).toEqual([]);
    });
    it("asks the editor to load a resolved internal path through preview-by-path (#946)", () => {
        const r = bootRuntime().click("/pricing/");
        expect(r.defaultPrevented).toBe(true);
        // The sandboxed preview never navigates itself: its own navigation
        // would carry no session. The branch rides along; the editor adds its
        // channel.
        expect(r.assigned).toEqual([]);
        expect(r.navigate).toEqual(["/edit/preview-by-path/pricing/?branch=b1"]);
    });
    it("goes nowhere without an editor channel", () => {
        const r = bootRuntime("?branch=b1").click("/pricing/");
        expect(r.defaultPrevented).toBe(true);
        expect(r.assigned).toEqual([]);
        expect(r.navigate).toEqual([]);
    });
});
