// SPDX-License-Identifier: MPL-2.0

/**
 * #1663 — `remove_module_from` removes the placement it is told to. These
 * pin the pure address rules (`pickPlacements`) and the content preview a
 * refusal shows per placement; the database path is in
 * remove-module-from.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { removeModuleFromToolInput } from "@caelo-cms/shared";
import { contentPreview, type PlacementAt, pickPlacements } from "../remove-module-from.js";

const at = (p: PlacementAt) => `${p.blockName}#${p.position}`;
const ONE: PlacementAt[] = [{ blockName: "content", position: 2 }];
const TWICE: PlacementAt[] = [
  { blockName: "content", position: 1 },
  { blockName: "content", position: 4 },
];
const SPREAD: PlacementAt[] = [
  { blockName: "header", position: 0 },
  { blockName: "content", position: 1 },
  { blockName: "content", position: 3 },
];

describe("pickPlacements", () => {
  it("removes a module placed once without an address", () => {
    expect(pickPlacements(ONE, {}, at)).toEqual({ ok: true, picked: ONE });
  });

  it("refuses a module placed twice without an address, listing both placements", () => {
    const r = pickPlacements(TWICE, {}, at);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("placed 2 times");
    expect(r.message).toContain("content#1; content#4");
    expect(r.message).toContain("blockName + position");
    expect(r.message).toContain("allPlacements:true");
  });

  it("removes exactly the addressed placement", () => {
    expect(pickPlacements(TWICE, { blockName: "content", position: 4 }, at)).toEqual({
      ok: true,
      picked: [{ blockName: "content", position: 4 }],
    });
  });

  it("accepts a block alone when it narrows to one placement", () => {
    expect(pickPlacements(SPREAD, { blockName: "header" }, at)).toEqual({
      ok: true,
      picked: [{ blockName: "header", position: 0 }],
    });
  });

  it("refuses a block alone that still holds the module twice", () => {
    const r = pickPlacements(SPREAD, { blockName: "content" }, at);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('placed 2 times in block "content"');
    expect(r.message).not.toContain("header#0");
  });

  it("refuses an address with no placement, naming the real ones", () => {
    const r = pickPlacements(TWICE, { blockName: "content", position: 2 }, at);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('no placement at block "content" position 2');
    expect(r.message).toContain("content#1; content#4");
  });

  it("removes every placement only when allPlacements says so", () => {
    expect(pickPlacements(SPREAD, { allPlacements: true }, at)).toEqual({
      ok: true,
      picked: SPREAD,
    });
    expect(pickPlacements(SPREAD, { allPlacements: true, blockName: "content" }, at)).toEqual({
      ok: true,
      picked: SPREAD.slice(1),
    });
  });

  it("refuses allPlacements together with a position", () => {
    const r = pickPlacements(TWICE, { allPlacements: true, position: 1 }, at);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("takes no position");
  });
});

describe("contentPreview", () => {
  it("shows the first text values, tags stripped and long text cut", () => {
    expect(
      contentPreview({
        title: "<strong>Book</strong> a call",
        body: "x".repeat(60),
        links: [{ label: "a" }, { label: "b" }],
        extra: "not shown",
      }),
    ).toBe(`title="Book a call", body="${"x".repeat(40)}…", links=[2 items]`);
  });

  it("says when a placement has no content", () => {
    expect(contentPreview({})).toBe("no content yet");
    expect(contentPreview({ title: "  " })).toBe("no content yet");
  });
});

describe("removeModuleFromToolInput", () => {
  const base = {
    target: "page",
    targetRef: "/termin",
    moduleId: "00000000-0000-4000-8000-000000000001",
  };

  it("takes a placement address, a numeric-string position included", () => {
    const r = removeModuleFromToolInput.safeParse({ ...base, blockName: "content", position: "4" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.position).toBe(4);
  });

  it("rejects a negative position and an unknown key", () => {
    expect(removeModuleFromToolInput.safeParse({ ...base, position: -1 }).success).toBe(false);
    expect(removeModuleFromToolInput.safeParse({ ...base, fromPosition: 1 }).success).toBe(false);
  });
});
