// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (regression guard) — keep MODULE_FIELDS_JSON_SCHEMA the single
 * source of truth for the module-`fields[]` provider schema.
 *
 * The footer bug was four hand-copied field schemas drifting; the round-2 fix
 * deduped them to `_module-fields-schema.ts`. Nothing structurally prevents a
 * future tool from re-inlining a `fields` array literal with its own `kind`
 * enum and re-introducing the exact drift. This test reads the tool sources
 * and asserts (a) every module-field-authoring tool references the shared
 * constant, and (b) NO module-authoring tool inlines a field-kind enum
 * literal (the drift vector).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(import.meta.dir, "..");

/** Tools that author a module `fields[]` surface — MUST use the shared schema. */
const FIELD_AUTHORING_TOOLS = [
  "add-module-to-page.ts",
  "add-module-to-layout.ts",
  "add-module-to-template.ts",
  "edit-module.ts",
] as const;

/**
 * compose-page-from-spec intentionally has NO module-fields surface (its
 * sections carry only displayName/html/css/js), so it must NOT reference the
 * shared schema — but it also must not grow an inline field-kind enum.
 */
const NO_INLINE_ENUM_TOOLS = [...FIELD_AUTHORING_TOOLS, "compose-page-from-spec.ts"] as const;

/**
 * Signature of an inlined field-kind enum literal — a `kind` enum that lists
 * the module field kinds (rather than the module-`kind` chrome/hero/... enum,
 * which legitimately appears as a separate property). Keyed on the list/
 * nested kinds that only ever belong to the field schema.
 */
const INLINE_FIELD_ENUM = /"text-list"|"link-list"|"module-list"/;

describe("MODULE_FIELDS_JSON_SCHEMA stays the single source of truth", () => {
  for (const file of FIELD_AUTHORING_TOOLS) {
    it(`${file} references the shared MODULE_FIELDS_JSON_SCHEMA`, () => {
      const src = readFileSync(join(TOOLS_DIR, file), "utf8");
      expect(src).toContain("MODULE_FIELDS_JSON_SCHEMA");
    });
  }

  for (const file of NO_INLINE_ENUM_TOOLS) {
    it(`${file} does not inline a field-kind enum literal`, () => {
      const src = readFileSync(join(TOOLS_DIR, file), "utf8");
      // The only place these list/nested kinds may appear is an import of the
      // shared schema — never a hand-written enum array inside the tool.
      expect(src).not.toMatch(INLINE_FIELD_ENUM);
    });
  }
});
