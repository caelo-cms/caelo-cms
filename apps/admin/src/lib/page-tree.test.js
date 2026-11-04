// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { orderAsTree, parentCandidates, subtreeIds } from "./page-tree.js";
const rows = [
    { id: "home", parentPageId: null, currentPath: "/" },
    { id: "alerts", parentPageId: "seo", currentPath: "/seo/alerts" },
    { id: "seo", parentPageId: null, currentPath: "/seo" },
    { id: "email", parentPageId: "alerts", currentPath: "/seo/alerts/email" },
    { id: "seo-x", parentPageId: null, currentPath: "/seo-x" },
    { id: "orphan", parentPageId: "gone", currentPath: "/gone/orphan" },
];
describe("page tree (admin)", () => {
    it("orders depth-first with depths; orphans stay visible at the top level", () => {
        const ordered = orderAsTree(rows).map((r) => `${r.depth}:${r.row.id}`);
        expect(ordered).toEqual(["0:home", "0:orphan", "0:seo", "1:alerts", "2:email", "0:seo-x"]);
    });
    it("subtree and parent candidates exclude self, descendants and the root", () => {
        expect([...subtreeIds(rows, "seo")].sort()).toEqual(["alerts", "email"]);
        expect(parentCandidates(rows, "seo")
            .map((r) => r.id)
            .sort()).toEqual(["orphan", "seo-x"]);
        expect(parentCandidates(rows, null).map((r) => r.id)).not.toContain("home");
    });
});
