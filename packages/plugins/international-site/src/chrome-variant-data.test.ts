// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — what the content-variants answer hands the host is plain data
 * (docs/dev/external-plugin-brokers.md §6.6, §4.5): only the fields the
 * placement's module declares, and text fields as text, so the host's
 * escaping renders a translation exactly as the source renders.
 */

import { describe, expect, it } from "bun:test";
import { asPlacementData } from "./chrome-ops.js";

describe("asPlacementData", () => {
  const fields = [
    { name: "tagline", kind: "text" },
    { name: "note", kind: "richtext" },
  ];

  it("keeps the declared fields and drops one the module no longer has", () => {
    expect(asPlacementData(fields, { tagline: "Hallo", note: "<p>x</p>", removed: "alt" })).toEqual(
      { tagline: "Hallo", note: "<p>x</p>" },
    );
  });

  it("decodes the character references a translation kept in a text field", () => {
    expect(
      asPlacementData(fields, {
        tagline: "AGB &amp; Datenschutz &#8211; &#x2014;&nbsp;&lt;b&gt; &copy;",
        note: "<p>A &amp; B</p>",
      }),
    ).toEqual({
      // An unknown named reference stays as written.
      tagline: "AGB & Datenschutz – — <b> &copy;",
      // Richtext is markup: its references stay.
      note: "<p>A &amp; B</p>",
    });
  });

  it("decodes the text fields of a local list's entries, by the list type", () => {
    const listTypes = new Map([
      [
        "links",
        {
          slug: "links",
          name: "Links",
          purpose: "Links",
          root: { allow: ["link"] },
          nodes: {
            link: {
              label: "Link",
              fields: [
                { name: "label", label: "Label", type: "text" as const },
                { name: "blurb", label: "Blurb", type: "richtext" as const },
              ],
            },
          },
        },
      ],
    ]);
    const entries = [
      {
        id: "a",
        node: "link",
        values: { label: "AGB &amp; Datenschutz", blurb: "<p>A &amp; B</p>" },
        children: [{ id: "b", node: "link", values: { label: "&quot;Hilfe&quot;" } }],
      },
    ];
    expect(
      asPlacementData(
        [{ name: "nav", kind: "list" }],
        { nav: entries },
        {
          fields: [{ name: "nav", kind: "list", listType: "links" }],
          listTypes,
        },
      ),
    ).toEqual({
      nav: [
        {
          id: "a",
          node: "link",
          values: { label: "AGB & Datenschutz", blurb: "<p>A &amp; B</p>" },
          children: [{ id: "b", node: "link", values: { label: '"Hilfe"' } }],
        },
      ],
    });
  });
});
