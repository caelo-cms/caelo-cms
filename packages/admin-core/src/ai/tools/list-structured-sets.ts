// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.22 — `list_structured_sets` (2026-07: makeListReadTool — TOON
 * output, uniform filter/limit/offset/full).
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listStructuredSetsInput = z
  .object({
    kind: z.enum(["nav-menu", "taxonomy", "tags", "link-list", "language-selector"]).optional(),
  })
  .strict();

export const listStructuredSetsTool = makeListReadTool<
  z.infer<typeof listStructuredSetsInput>,
  { kind: string; slug: string; displayName: string; items: unknown }
>({
  name: "list_structured_sets",
  description:
    "List structured-data sets (nav menus, tags, taxonomies, link-lists, language-selectors) with item counts (TOON rows). " +
    "Optional `kind`, plus the standard list params: `filter`, `limit`/`offset`, `full: true`. " +
    "The context block inlines nav-menu items at session start; call this after writes or when the listing was truncated.",
  opName: "structured_sets.list",
  input: listStructuredSetsInput,
  label: "structured_sets",
  rows: (value) =>
    (value as { sets: { kind: string; slug: string; displayName: string; items: unknown }[] }).sets,
  columns: [
    { key: "kind", value: (s) => s.kind },
    { key: "slug", value: (s) => s.slug },
    { key: "displayName", value: (s) => s.displayName },
    { key: "items", value: (s) => (Array.isArray(s.items) ? s.items.length : 0) },
  ],
  emptyMessage: "No structured sets on this site yet — create one with set_structured_set.",
});
