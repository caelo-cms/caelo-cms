// SPDX-License-Identifier: MPL-2.0

/**
 * #1732 review, round 2 — a nested module's plugin values are checked
 * against its own template read as a `<body>`'s content. That holds only
 * where its parent puts it in plain HTML element content; anywhere else
 * (raw text, an attribute, a script, SVG, a `<select>`) every plugin value
 * inside it, and inside its own nested modules, is refused.
 */

import { describe, expect, it } from "bun:test";
import { pluginValue } from "./lists/plugin-values.js";
import { type NestedRenderResolver, renderPlacedModule } from "./nested-module-render.js";

const CHILD = "00000000-0000-4000-8000-000000000c01";
const CHILD_CI = "00000000-0000-4000-8000-000000000c02";
const GRAND = "00000000-0000-4000-8000-000000000c03";
const GRAND_CI = "00000000-0000-4000-8000-000000000c04";

function resolverWith(childHtml: string, body: unknown): NestedRenderResolver {
  return {
    getModule: (id) =>
      id === CHILD
        ? {
            moduleId: CHILD,
            slug: "child",
            html: childHtml,
            css: "",
            js: "",
            fields: [
              { name: "body", kind: "richtext" },
              { name: "inner", kind: "module" },
            ],
          }
        : id === GRAND
          ? {
              moduleId: GRAND,
              slug: "grand",
              html: "<p>{{body}}</p>",
              css: "",
              js: "",
              fields: [{ name: "body", kind: "richtext" }],
            }
          : null,
    getContentInstance: (id) =>
      id === CHILD_CI
        ? {
            id: CHILD_CI,
            moduleId: CHILD,
            values: { body, inner: { moduleId: GRAND, contentInstanceId: GRAND_CI } },
            deletedAt: null,
          }
        : id === GRAND_CI
          ? { id: GRAND_CI, moduleId: GRAND, values: { body }, deletedAt: null }
          : null,
  };
}

const owned = (value: string) =>
  pluginValue(
    { plugin: "evil", point: "content-variants", address: "child/body", type: "richtext" },
    value,
  );

function placed(parentHtml: string, childHtml: string, body: unknown) {
  return renderPlacedModule(
    {
      html: parentHtml,
      fields: [{ name: "fallback", kind: "module" }],
      values: { fallback: { moduleId: CHILD, contentInstanceId: CHILD_CI } },
    },
    resolverWith(childHtml, body),
    {},
  );
}

describe("a nested module's plugin values where its parent puts it (#1732 review)", () => {
  it("refuses them when the parent puts it in raw text, an attribute or a script", () => {
    for (const [parent, child, value] of [
      [
        "<noscript>{{>fallback}}</noscript>",
        '<div class="notice">{{body}}</div>',
        '<p title="</noscript><img src=x onerror=alert(1)>">Bitte JavaScript aktivieren</p>',
      ],
      ['<a href="{{>fallback}}">x</a>', "{{body}}", "javascript:alert(1)"],
      ["<script>{{>fallback}}</script>", "{{body}}", "alert(1)"],
      ["<select><option>{{>fallback}}</option></select>", "{{body}}", "<p>x</p>"],
    ] as const) {
      const r = placed(parent, child, owned(value));
      expect(r.failures.map((f) => f.reason)).toContain(
        "plugin-value-refused:evil.content-variants.child/body:context-nested-placement",
      );
      expect(r.html).not.toContain("alert(1)");
    }
  });

  it("refuses them in the nested module's own nested modules too", () => {
    const r = placed(
      "<noscript>{{>fallback}}</noscript>",
      "<div>{{>inner}}</div>",
      owned("<p>x</p>"),
    );
    expect(r.failures.map((f) => f.reason)).toContain(
      "plugin-value-refused:evil.content-variants.child/body:context-nested-placement",
    );
  });

  it("keeps them where the parent puts it in plain element content", () => {
    const r = placed(
      "<section>{{>fallback}}</section>",
      "<div>{{body}}</div>",
      owned("<p>Hallo</p>"),
    );
    expect(r.failures).toEqual([]);
    expect(r.html).toContain("<p>Hallo</p>");
  });
});
