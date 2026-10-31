// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { conditionsHold, fillCopy, formatValue, mapArgs, parseFields, pluginNavLinks, valueAt, } from "./plugin-panels.js";
describe("valueAt", () => {
    const row = { id: "a", approvedSend: { status: "sending", processed: 3 }, none: null };
    it("reads nested paths and reports missing steps as undefined", () => {
        expect(valueAt(row, "approvedSend.status")).toBe("sending");
        expect(valueAt(row, "none.status")).toBeUndefined();
        expect(valueAt(row, "missing")).toBeUndefined();
    });
    it("never walks into the prototype", () => {
        expect(valueAt(row, "constructor")).toBeUndefined();
        expect(valueAt(row, "toString")).toBeUndefined();
    });
});
describe("conditionsHold", () => {
    it("treats a missing value as null", () => {
        expect(conditionsHold({ status: "draft" }, [{ key: "approvedSend", in: [null] }])).toBe(true);
        expect(conditionsHold({ status: "draft", approvedSend: { status: "done" } }, [
            { key: "approvedSend", in: [null] },
        ])).toBe(false);
    });
    it("ANDs every condition", () => {
        const when = [
            { key: "status", notIn: ["archived"] },
            { key: "status", in: ["new", "read"] },
        ];
        expect(conditionsHold({ status: "new" }, when)).toBe(true);
        expect(conditionsHold({ status: "archived" }, when)).toBe(false);
        expect(conditionsHold({ status: "spam" }, when)).toBe(false);
    });
});
describe("fillCopy", () => {
    it("fills values as text and leaves an unknown placeholder visible", () => {
        expect(fillCopy("Queued {queued}; {missing}.", { queued: 4 })).toBe("Queued 4; {missing}.");
        expect(fillCopy("{x}", { x: "<script>" })).toBe("<script>");
    });
});
describe("formatValue", () => {
    it("scales numbers", () => {
        expect(formatValue({ key: "a", label: "A", format: "number", divisor: 100, decimals: 2 }, 425)).toBe("4.25");
    });
    it("joins lists and pretty-prints JSON", () => {
        expect(formatValue({ key: "g", label: "G", format: "list" }, ["analytics", "ads"])).toBe("analytics, ads");
        expect(formatValue({ key: "d", label: "D", format: "json" }, { a: 1 })).toBe('{\n  "a": 1\n}');
    });
    it("shows a missing value as empty", () => {
        expect(formatValue({ key: "s", label: "S", format: "text" }, undefined)).toBe("");
    });
});
describe("mapArgs", () => {
    it("takes declared values from the row and refuses non-primitives", () => {
        expect(mapArgs({ commentId: "id" }, { id: "c1", content: "x" })).toEqual({
            ok: true,
            args: { commentId: "c1" },
        });
        expect(mapArgs({ data: "data" }, { data: { a: 1 } })).toEqual({ ok: false, missing: "data" });
    });
});
describe("parseFields", () => {
    const fields = [
        { arg: "slug", label: "Slug", input: "text", required: true, maxLength: 5 },
        { arg: "days", label: "Days", input: "number", required: false, integer: true, min: 1 },
        { arg: "on", label: "On", input: "checkbox" },
        {
            arg: "kind",
            label: "Kind",
            input: "select",
            required: false,
            options: [{ value: "a", label: "A" }],
        },
    ];
    const form = (entries) => {
        const f = new FormData();
        for (const [k, v] of Object.entries(entries))
            f.set(k, v);
        return f;
    };
    it("validates against the declaration and leaves empty optional fields out", () => {
        expect(parseFields(fields, form({ slug: "abc", days: "", on: "on" }))).toEqual({
            ok: true,
            args: { slug: "abc", on: true },
        });
        expect(parseFields(fields, form({ slug: "abc", days: "30", kind: "a" }))).toEqual({
            ok: true,
            args: { slug: "abc", days: 30, on: false, kind: "a" },
        });
    });
    it("refuses values outside the declared limits", () => {
        expect(parseFields(fields, form({}))).toEqual({ ok: false, error: "Slug: required." });
        expect(parseFields(fields, form({ slug: "toolong" })).ok).toBe(false);
        expect(parseFields(fields, form({ slug: "a", days: "1.5" })).ok).toBe(false);
        expect(parseFields(fields, form({ slug: "a", days: "0" })).ok).toBe(false);
        expect(parseFields(fields, form({ slug: "a", kind: "b" })).ok).toBe(false);
    });
});
describe("pluginNavLinks", () => {
    const plugins = [
        {
            slug: "newsletter",
            panels: [
                {
                    slug: "campaigns",
                    title: "Newsletter",
                    icon: "mail",
                    permission: "settings.write",
                },
            ],
        },
        {
            slug: "consent-manager",
            panels: [
                {
                    slug: "log",
                    title: "Consent log",
                    icon: "shield-check",
                    permission: "privacy.view",
                },
            ],
        },
    ];
    it("lists only panels the viewer may open, by plugin slug", () => {
        expect(pluginNavLinks(plugins, new Set(["settings.write", "privacy.view"]))).toEqual([
            { href: "/plugins/consent-manager/log", label: "Consent log", icon: "shield-check" },
            { href: "/plugins/newsletter/campaigns", label: "Newsletter", icon: "mail" },
        ]);
        expect(pluginNavLinks(plugins, ["settings.write"]).map((l) => l.label)).toEqual(["Newsletter"]);
    });
    it("is empty without a permitted panel, so there is no Plugins entry", () => {
        expect(pluginNavLinks(plugins, ["content.read"])).toEqual([]);
        expect(pluginNavLinks([], ["settings.write"])).toEqual([]);
    });
});
