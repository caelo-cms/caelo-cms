// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { applySlotReplacements } from "../preview/scanner.js";

const map = (entries: [string, string][]) => new Map(entries);

describe("applySlotReplacements", () => {
  it("returns input unchanged when there are no slots", () => {
    const html = "<html><body><h1>Static</h1></body></html>";
    const result = applySlotReplacements(html, { contentByName: map([]) });
    expect(result.html).toBe(html);
    expect(result.replacedSlots).toEqual([]);
    expect(result.missingSlots).toEqual([]);
  });

  it("replaces a single named slot's inner HTML", () => {
    const html = `<body><caelo-slot name="content">placeholder</caelo-slot></body>`;
    const result = applySlotReplacements(html, {
      contentByName: map([["content", "<p>HELLO</p>"]]),
    });
    expect(result.html).toBe(`<body><caelo-slot name="content"><p>HELLO</p></caelo-slot></body>`);
    expect(result.replacedSlots).toEqual(["content"]);
  });

  it("preserves the slot wrapper so CSS selectors still match", () => {
    const html = `<caelo-slot name="x"></caelo-slot>`;
    const result = applySlotReplacements(html, { contentByName: map([["x", "FILLED"]]) });
    expect(result.html).toBe(`<caelo-slot name="x">FILLED</caelo-slot>`);
  });

  it("replaces multiple slots in order", () => {
    const html = `<caelo-slot name="header">_</caelo-slot><caelo-slot name="footer">_</caelo-slot>`;
    const result = applySlotReplacements(html, {
      contentByName: map([
        ["header", "TOP"],
        ["footer", "BOT"],
      ]),
    });
    expect(result.html).toBe(
      `<caelo-slot name="header">TOP</caelo-slot><caelo-slot name="footer">BOT</caelo-slot>`,
    );
    expect(result.replacedSlots).toEqual(["header", "footer"]);
  });

  it("records slots without a replacement and preserves their original inner HTML", () => {
    const html = `<caelo-slot name="missing">DEFAULT</caelo-slot>`;
    const result = applySlotReplacements(html, { contentByName: map([]) });
    expect(result.html).toBe(`<caelo-slot name="missing">DEFAULT</caelo-slot>`);
    expect(result.missingSlots).toEqual(["missing"]);
  });

  it("handles single-quoted name attributes", () => {
    const html = `<caelo-slot name='content'>x</caelo-slot>`;
    const result = applySlotReplacements(html, { contentByName: map([["content", "Y"]]) });
    expect(result.html).toBe(`<caelo-slot name='content'>Y</caelo-slot>`);
  });

  it("throws on an unterminated slot opener", () => {
    expect(() =>
      applySlotReplacements(`<caelo-slot name="x">no close`, { contentByName: map([]) }),
    ).toThrow(/unterminated/);
  });

  it("throws on a nested slot", () => {
    const html = `<caelo-slot name="a"><caelo-slot name="b">y</caelo-slot></caelo-slot>`;
    expect(() => applySlotReplacements(html, { contentByName: map([]) })).toThrow(/nested/);
  });

  it("leaves bytes outside slots unchanged", () => {
    const before = `<!doctype html><html lang="en"><head><title>T</title></head><body>`;
    const after = `</body></html>`;
    const html = `${before}<caelo-slot name="x">_</caelo-slot>${after}`;
    const result = applySlotReplacements(html, { contentByName: map([["x", "Y"]]) });
    expect(result.html).toBe(`${before}<caelo-slot name="x">Y</caelo-slot>${after}`);
  });

  it("ignores caelo-slot inside an HTML comment", () => {
    // The regex-based version mistakenly treated this as a real slot. The
    // parser-based version ignores everything inside <!-- … -->.
    const html = `<!-- <caelo-slot name="ghost">x</caelo-slot> --><caelo-slot name="real">_</caelo-slot>`;
    const result = applySlotReplacements(html, { contentByName: map([["real", "Y"]]) });
    expect(result.html).toBe(
      `<!-- <caelo-slot name="ghost">x</caelo-slot> --><caelo-slot name="real">Y</caelo-slot>`,
    );
    expect(result.replacedSlots).toEqual(["real"]);
    expect(result.missingSlots).toEqual([]);
  });

  it("ignores caelo-slot mention inside an attribute value", () => {
    const html = `<div data-doc="example: <caelo-slot name='fake'>"></div><caelo-slot name="real">_</caelo-slot>`;
    const result = applySlotReplacements(html, { contentByName: map([["real", "Y"]]) });
    expect(result.html).toContain(`<caelo-slot name="real">Y</caelo-slot>`);
    expect(result.replacedSlots).toEqual(["real"]);
  });
});
