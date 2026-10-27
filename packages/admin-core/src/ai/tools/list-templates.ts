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
    "List templates: UUID, slug, name, layout UUID, `pageBlocks`, `pageTypes` (page types allowed to use it). Use for a template id or its blocks before building a page; never ask the operator for a UUID.\n" +
    "`pageBlocks` = the ONLY valid `blockName` for `build_page` / `add_module` target='page' (usually `content`). " +
    "Header/footer/nav are layout chrome (`list_layouts`), placed once via `add_module` target='layout'.",
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
