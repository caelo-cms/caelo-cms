// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_templates` (2026-07: makeListReadTool — TOON output,
 * uniform filter/limit/offset/full).
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

interface TemplateRow {
  id: string;
  slug: string;
  displayName: string;
  layoutId: string;
  blocks: { name: string }[];
  pageTypes: string[];
}

const listTemplatesInput = z.object({ includeDeleted: z.boolean().default(false) }).strict();

export const listTemplatesTool = makeListReadTool<z.infer<typeof listTemplatesInput>, TemplateRow>({
  name: "list_templates",
  description:
    "List every template with UUID, slug, display name, bound layout UUID, `pageBlocks` and `pageTypes` (the page types whose pages may use it — list_page_types) (TOON rows). " +
    "`pageBlocks` are the blocks a page on that template places modules into — the ONLY valid `blockName` values for build_page and add_module target='page' (usually just `content`). " +
    "Header / footer / nav are NOT page blocks: they are site chrome on the template's LAYOUT (list_layouts), placed once with add_module target='layout'. " +
    "Standard list params: `filter`, `limit`/`offset`, `full: true`. " +
    "Use when you need a template UUID or its blocks before building a page. DO NOT ask the operator to paste a UUID.",
  opName: "templates.list",
  input: listTemplatesInput,
  label: "templates",
  rows: (value) => (value as { templates: TemplateRow[] }).templates,
  columns: [
    { key: "slug", value: (t) => t.slug },
    { key: "id", value: (t) => t.id },
    { key: "displayName", value: (t) => t.displayName },
    { key: "layoutId", value: (t) => t.layoutId },
    // #1076 — without this column the only block list the AI had read was
    // the layout's `header|content|footer`, and it placed a header via
    // build_page. See _block-roles.ts.
    { key: "pageBlocks", value: (t) => t.blocks.map((b) => b.name).join("|") },
    { key: "pageTypes", value: (t) => t.pageTypes.join("|") },
  ],
  emptyMessage:
    "No templates on this site yet. Call create_template (pass layoutId from list_layouts) to create one.",
});
