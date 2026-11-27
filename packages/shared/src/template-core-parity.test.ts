// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — core values render exactly as before #1732, whether or not a
 * plugin's value sits next to them. Base vs head: the golden file holds
 * what main's engine rendered for 1,024 templates
 * (`scripts/template-core-parity-golden.ts`); this checkout must render the
 * same, with core values only and with an unused plugin value added. The
 * #1732 review found 41 templates (every `{{{link}}}`) that changed once a
 * plugin's value was present.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
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
      return JSON.stringify([r.html, r.missingSlots]) !== JSON.stringify(golden.renders[i]);
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
      return JSON.stringify([r.html, r.missingSlots]) !== JSON.stringify(golden.renders[i]);
    });
    expect(differ).toEqual([]);
  });

  it("saves a `{{&field.path}}` as before", () => {
    expect(fieldPathProblems(CORE_PARITY_FIELD_PATHS, CORE_PARITY_FIELDS)).toEqual(
      golden.fieldPaths as ReturnType<typeof fieldPathProblems>,
    );
  });
});
