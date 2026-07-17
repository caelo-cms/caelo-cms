// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_templates` (2026-07: makeListReadTool — TOON output,
 * uniform filter/limit/offset/full).
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listTemplatesInput = z.object({ includeDeleted: z.boolean().default(false) }).strict();

export const listTemplatesTool = makeListReadTool<
  z.infer<typeof listTemplatesInput>,
  { id: string; slug: string; displayName: string; layoutId: string }
>({
  name: "list_templates",
  description:
    "List every template with UUID, slug, display name, and bound layout UUID (TOON rows). " +
    "Standard list params: `filter`, `limit`/`offset`, `full: true`. " +
    "Use when you need a template UUID that isn't in the `# Templates → layouts` context block. DO NOT ask the operator to paste a UUID.",
  opName: "templates.list",
  input: listTemplatesInput,
  label: "templates",
  rows: (value) =>
    (
      value as {
        templates: { id: string; slug: string; displayName: string; layoutId: string }[];
      }
    ).templates,
  columns: [
    { key: "slug", value: (t) => t.slug },
    { key: "id", value: (t) => t.id },
    { key: "displayName", value: (t) => t.displayName },
    { key: "layoutId", value: (t) => t.layoutId },
  ],
  emptyMessage:
    "No templates on this site yet. Call create_template (pass layoutId from list_layouts) to create one.",
});
