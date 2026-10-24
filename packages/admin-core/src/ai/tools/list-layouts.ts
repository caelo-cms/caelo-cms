// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_layouts` (2026-07: makeListReadTool — TOON output,
 * uniform filter/limit/offset/full). Read fallback for the layouts
 * context block; carries the UUIDs the AI needs for create_template.
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listLayoutsInput = z.object({ includeDeleted: z.boolean().default(false) }).strict();

export const listLayoutsTool = makeListReadTool<
  z.infer<typeof listLayoutsInput>,
  {
    id: string;
    slug: string;
    displayName: string;
    blocks: { name: string; moduleSlugs?: string[] }[];
  }
>({
  name: "list_layouts",
  description:
    'List every layout with UUID, slug, display name, and its LAYOUT blocks INCLUDING the chrome modules placed in each (`header(nav-menu-main)|content|footer(site-footer)`). One read answers "is module X already on the layout?". ' +
    "Layout blocks are site chrome: place a header / footer / nav into them ONCE for every page with add_module target='layout'. They are NOT build_page blockNames — a page places into its TEMPLATE's blocks (list_templates `pageBlocks`, usually just `content`); the layout's `content` block is where the template renders. " +
    "Standard list params: `filter`, `limit`/`offset`, `full: true`. " +
    "Use when you need a layout UUID or slug (e.g. right after an Owner approved a layout-create proposal). DO NOT ask the operator to paste a UUID.",
  opName: "layouts.list",
  input: listLayoutsInput,
  label: "layouts",
  rows: (value) =>
    (
      value as {
        layouts: {
          id: string;
          slug: string;
          displayName: string;
          blocks: { name: string; moduleSlugs?: string[] }[];
        }[];
      }
    ).layouts,
  columns: [
    { key: "slug", value: (l) => l.slug },
    { key: "id", value: (l) => l.id },
    { key: "displayName", value: (l) => l.displayName },
    {
      key: "layoutBlocks(modules)",
      // "header(nav-menu-main)|content|footer(site-footer)" — answers
      // "is my footer already on the layout?" in ONE read (run-B2 gap:
      // the AI tool-searched for a layout-placements read that didn't
      // exist).
      value: (l) =>
        l.blocks
          .map((b) =>
            (b.moduleSlugs?.length ?? 0) > 0
              ? `${b.name}(${(b.moduleSlugs ?? []).join(",")})`
              : b.name,
          )
          .join("|"),
    },
  ],
  emptyMessage:
    "No layouts on this site yet. Call create_layout to propose one (Owner-approved), then re-run list_layouts to fetch the resulting UUID.",
});
