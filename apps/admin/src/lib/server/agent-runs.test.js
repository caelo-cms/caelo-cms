// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { requireAgentControl } from "./agent-runs.js";
function localsWith(permissions) {
    return { user: { id: "u1", permissions: new Set(permissions) } };
}
function status(fn) {
    try {
        fn();
        return null;
    }
    catch (e) {
        return e.status ?? -1;
    }
}
describe("requireAgentControl (Stop / Allow on running agents)", () => {
    it("admits a chat writer", () => {
        expect(status(() => requireAgentControl(localsWith(["content.read", "content.write"])))).toBe(null);
    });
    it("admits a site administrator whose role lacks content.write", () => {
        expect(status(() => requireAgentControl(localsWith(["content.read", "settings.write"])))).toBe(null);
    });
    it("refuses a read-only Reviewer with 403", () => {
        expect(status(() => requireAgentControl(localsWith(["content.read", "settings.read"])))).toBe(403);
    });
});
