// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — core values render exactly as before #1732, whether or not a
 * plugin's value sits next to them. Base vs head: the golden file holds
 * what main's engine rendered for 1,024 templates
 * (`scripts/template-core-parity-golden.ts`); this checkout must render the
 * same, with core values only and with an unused plugin value added. The
 * #1732 review found 41 templates (every `{{{link}}}`) that changed once a
 * plugin's value was present.
 *
 * #1748 — the one deliberate difference: a core value that changes the
 * markup around its placeholder (the fixture's `<c>`, `D<b>`, `<!-- c -->`)
 * still renders exactly as before, and now also fails as
 * `value-breaks-markup`. Those markers are compared apart from the golden.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isValueBreaksMarkupMarker } from "./core-value-messages.js";
import { pluginValue } from "./lists/plugin-values.js";
import {
  CORE_PARITY_FIELD_PATHS,
  CORE_PARITY_FIELDS,
  CORE_PARITY_VALUES,
  coreParityTemplates,
} from "./template-core-parity-fixtures.test.js";
import { renderTemplate } from "./template-engine.js";
import { fieldPathProblems } from "./template-sections.js";

const golden = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/template-core-parity.golden.json", import.meta.url),
    "utf8",
  ),
) as { renders: [string, string[]][]; fieldPaths: unknown };

const PLUGIN_VALUE = pluginValue(
  { plugin: "probe", point: "content-variants", address: "m/pv", type: "text" },
  "zzz",
);

/** A render as the golden holds it: the HTML and the markers main recorded (#1748's aside). */
function asBefore(r: { html: string; missingSlots: readonly string[] }): string {
  return JSON.stringify([r.html, r.missingSlots.filter((m) => !isValueBreaksMarkupMarker(m))]);
}

describe("core rendering is the same as before #1732 (#1729)", () => {
  const templates = coreParityTemplates();

  it("renders every template of the matrix as main did, with core values only", () => {
    expect(templates.length).toBe(golden.renders.length);
    const differ = templates.filter((html, i) => {
      const r = renderTemplate({
        html,
        fields: CORE_PARITY_FIELDS,
        contentValues: CORE_PARITY_VALUES,
      });
      return asBefore(r) !== JSON.stringify(golden.renders[i]);
    });
    expect(differ).toEqual([]);
  });

  it("renders them the same when a plugin's value sits next to the core values", () => {
    const differ = templates.filter((html, i) => {
      const r = renderTemplate({
        html,
        fields: CORE_PARITY_FIELDS,
        contentValues: { ...CORE_PARITY_VALUES, pv: PLUGIN_VALUE },
      });
      return asBefore(r) !== JSON.stringify(golden.renders[i]);
    });
    expect(differ).toEqual([]);
  });

  it("records #1748's breaking values without changing what renders", () => {
    const kinds = new Set<string>();
    for (const html of templates) {
      const r = renderTemplate({
        html,
        fields: CORE_PARITY_FIELDS,
        contentValues: CORE_PARITY_VALUES,
      });
      for (const m of r.missingSlots.filter(isValueBreaksMarkupMarker)) kinds.add(m);
    }
    // The fixture's values break where the templates place them: `<c>` and
    // `D<b>` are never closed, the richtext holds a comment, and a title
    // with spaces sits in an unquoted attribute.
    expect([...kinds].sort()).toEqual([
      "value-breaks-markup:body:comment",
      "value-breaks-markup:deflt:unclosed-b",
      "value-breaks-markup:title:attribute-space",
      "value-breaks-markup:title:unclosed-c",
    ]);
  });

  it("saves a `{{&field.path}}` as before", () => {
    expect(fieldPathProblems(CORE_PARITY_FIELD_PATHS, CORE_PARITY_FIELDS)).toEqual(
      golden.fieldPaths as ReturnType<typeof fieldPathProblems>,
    );
  });
});
