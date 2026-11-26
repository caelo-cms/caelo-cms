// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a local list a plugin handed a placement (a content variant) is
 * checked where it renders, against the fields of its list type
 * (docs/dev/external-plugin-brokers.md §4.5): its entries' shape first,
 * then the rule for each field. Text is escaped, so `" onmouseover="` cannot
 * leave a quoted attribute; a link keeps to the link rule; a value of
 * another type is refused. A refused value
 * fails with `plugin-value-refused` and renders raw.
 */

import { describe, expect, it } from "bun:test";
import { fixtureData, PAGE } from "./list-fixtures.test.js";
import { pluginLocalList } from "./plugin-values.js";
import { createListRenderContext, type ListFieldSpec } from "./resolve.js";
import type { ScopeEntry, ScopeValue } from "./scope.js";

const ITEM = "00000000-0000-4000-9000-000000000001";
const LINKS: ListFieldSpec = { name: "links", listType: "links" };
const OWNER = { plugin: "probe", address: "layout:footer:0/links" };

function resolve(value: unknown) {
  return createListRenderContext(fixtureData())
    .forPage(PAGE.home, {})
    .resolveField(LINKS, value, { contentInstanceId: null });
}

function entry(values: Record<string, unknown>): ScopeEntry {
  const r = resolve(pluginLocalList(OWNER, [{ id: ITEM, node: "link", values }]));
  if (!r.ok) throw new Error(r.marker);
  return r.entries[0] as ScopeEntry;
}

const failed = (v: ScopeValue | undefined) => (v?.kind === "failed" ? v.marker : null);

describe("a plugin's local list entries (#1729, §4.5)", () => {
  it("escapes a text field, so its value cannot leave a quoted attribute", () => {
    const e = entry({ label: '" onmouseover="alert(1)', link: { href: "/de/docs" } });
    expect(e.get("label")).toEqual({ kind: "text", text: "&quot; onmouseover=&quot;alert(1)" });
    expect(failed(e.get("link"))).toBeNull();
  });

  it("refuses a script link and a value of another type", () => {
    const e = entry({
      label: ["<img src=x onerror=alert(1)>"],
      link: { href: "javascript&#58;alert(1)", target: "_blank" },
    });
    expect(failed(e.get("label"))).toBe(
      `plugin-value-refused:probe.content-variants.${OWNER.address}/item/${ITEM}/label:type-text`,
    );
    expect(failed(e.get("link"))).toMatch(/:url-scheme$/);
  });

  it("refuses a link target the list type does not allow", () => {
    const e = entry({ label: "Docs", link: { href: "/docs", target: '_blank" onclick="x' } });
    expect(failed(e.get("link"))).toMatch(/:type-link$/);
  });

  it("refuses entries that are no tree of the list type as the plugin's", () => {
    const r = resolve(pluginLocalList(OWNER, [{ id: ITEM, node: "no-such-node", values: {} }]));
    expect(r).toEqual({
      ok: false,
      marker: `plugin-value-refused:probe.content-variants.${OWNER.address}:list-shape`,
    });
  });

  it("leaves core's own local entries as stored", () => {
    const r = resolve([{ id: ITEM, node: "link", values: { label: "<em>Docs</em>", link: "/d" } }]);
    if (!r.ok) throw new Error(r.marker);
    expect(r.entries[0]?.get("label")).toEqual({ kind: "text", text: "<em>Docs</em>" });
  });
});
