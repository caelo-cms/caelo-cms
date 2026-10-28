// SPDX-License-Identifier: MPL-2.0

/**
 * #1100 — `keepStoredDefaults` carries a stored default over only to a field
 * whose default would still fit: same kind, and for a list the same binding
 * and list type (a `texts` entry is not a `links` entry).
 */

import { describe, expect, it } from "bun:test";
import type { ModuleField } from "@caelo-cms/shared";
import { keepStoredDefaults } from "../_module-field-defaults.js";

const list = (listType: string, extra: Record<string, unknown> = {}) =>
  ({ name: "items", kind: "list", label: "Items", listType, ...extra }) as unknown as ModuleField;

describe("keepStoredDefaults", () => {
  it("keeps the stored default of a resent list with the same type", () => {
    const stored = [list("texts", { default: [{ text: "a" }] })];
    const r = keepStoredDefaults([list("texts")], stored);
    expect(r.kept).toEqual(["items"]);
    expect((r.fields[0] as { default?: unknown }).default).toEqual([{ text: "a" }]);
  });

  it("drops the stored default when the list type changes", () => {
    const stored = [list("texts", { default: [{ text: "a" }] })];
    const r = keepStoredDefaults([list("links")], stored);
    expect(r.kept).toEqual([]);
    expect("default" in (r.fields[0] as object)).toBe(false);
  });
});
