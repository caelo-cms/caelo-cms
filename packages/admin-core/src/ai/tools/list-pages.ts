// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_pages` (2026-07: makeListReadTool — TOON output,
 * uniform filter/limit/offset/full). The AI's read path for pages: the
 * system prompt carries no page list (CLAUDE.md §11).
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listPagesInput = z
  .object({
    includeDeleted: z.boolean().default(false),
    underPageId: z.string().uuid().optional().describe("Only this page's subtree."),
  })
  .strict();

interface ListedPage {
  id: string;
  slug: string;
  currentPath: string;
  parentPageId: string | null;
  depth: number;
  title: string;
  shortTitle: string;
  status?: string;
  templateId: string;
  pageType: string;
}

export const listPagesTool = makeListReadTool<z.infer<typeof listPagesInput>, ListedPage>({
  name: "list_pages",
  description:
    "List pages (TOON rows): path, UUID, slug, parent UUID, depth (1 = top level), title, short title (breadcrumb/navigation label), page type (what the page IS, e.g. `news`; `list_page_types`), template UUID. URL = parent URL + '/' + slug. Inside a chat, paths show its pending moves. Use for any page UUID/path; never ask the operator to paste a UUID.",
  opName: "pages.list",
  input: listPagesInput,
  label: "pages",
  rows: (value) => (value as { pages: ListedPage[] }).pages,
  columns: [
    { key: "path", value: (p) => p.currentPath },
    { key: "id", value: (p) => p.id },
    { key: "slug", value: (p) => p.slug },
    { key: "parentId", value: (p) => p.parentPageId ?? "" },
    { key: "depth", value: (p) => String(p.depth) },
    { key: "title", value: (p) => p.title },
    { key: "shortTitle", value: (p) => p.shortTitle },
    { key: "pageType", value: (p) => p.pageType },
    { key: "templateId", value: (p) => p.templateId },
  ],
  emptyMessage:
    "No pages on this site yet. Call build_page (pass page.templateId from list_templates; modules:[] for an empty shell) to create one.",
});
