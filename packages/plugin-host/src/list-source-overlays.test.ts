// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { ListResolveSource } from "@caelo-cms/plugin-sdk";
import { acceptedSourceValues, markedSourceEntries } from "./list-source-overlays.js";

const source = (name: string, field: string): ListResolveSource => ({
  name,
  label: name,
  fields: [{ name: field, label: field, type: "text" }],
  entries: [{ id: "e1", values: { [field]: "Text" } }],
});
const offered = new Map([
  ["plugin-a", [source("alpha", "label")]],
  ["plugin-b", [source("beta", "title")]],
]);

describe("#1323 — a source overlay is held to what was offered to its sender", () => {
  it("a plugin sets a field offered to it", () => {
    const { byVariant, issues } = acceptedSourceValues(
      {
        plugins: [
          {
            slug: "plugin-a",
            overlays: { en: { values: { "source/alpha/item/e1/label": "Hi" }, hidden: [] } },
          },
        ],
      },
      offered,
    );
    expect(issues).toEqual([]);
    expect(byVariant.get("en")?.get("alpha/e1")).toEqual({ label: "Hi" });
  });

  it("a field offered only to another contributor is refused and reported", () => {
    const { byVariant, issues } = acceptedSourceValues(
      {
        plugins: [
          {
            slug: "plugin-a",
            overlays: { en: { values: { "source/beta/item/e1/title": "Taken" }, hidden: [] } },
          },
        ],
      },
      offered,
    );
    expect(byVariant.get("en")?.size).toBe(0);
    expect(issues.map((i) => i.reason)).toEqual([
      "the source does not offer this field to this plugin",
    ]);
  });

  it("an entry the source did not answer and a hidden entry are reported", () => {
    const { issues } = acceptedSourceValues(
      {
        plugins: [
          {
            slug: "plugin-a",
            overlays: {
              en: {
                values: { "source/alpha/item/ghost/label": "Hi" },
                hidden: ["source/alpha/item/e1"],
              },
            },
          },
        ],
      },
      offered,
    );
    expect(issues.map((i) => i.reason)).toEqual([
      "no such list source entry",
      "an entry of a list source cannot be hidden",
    ]);
  });
});

describe("#1323 — markedSourceEntries", () => {
  const marked = [{ name: "alpha", label: "Alpha", fields: source("alpha", "label").fields }];

  it("keeps a source that answered with no entries: its entries are gone, not unknown", () => {
    expect(markedSourceEntries(marked, { alpha: [] }).map((s) => s.name)).toEqual(["alpha"]);
  });

  it("leaves out a source that did not answer", () => {
    expect(markedSourceEntries(marked, {})).toEqual([]);
  });
});
