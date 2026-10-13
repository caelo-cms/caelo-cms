// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_pages` (2026-07: makeListReadTool — TOON output,
 * uniform filter/limit/offset/full). Read fallback for the `# All pages`
 * context block; the block is a turn-start snapshot, this is live.
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listPagesInput = z
  .object({
    includeDeleted: z.boolean().default(false),
    /** Only the pages below this page (its whole subtree). */
    underPageId: z.string().uuid().optional(),
  })
  .strict();

interface ListedPage {
  id: string;
  slug: string;
  currentPath: string;
  parentPageId: string | null;
  depth: number;
  title: string;
  status?: string;
  templateId: string;
}

export const listPagesTool = makeListReadTool<z.infer<typeof listPagesInput>, ListedPage>({
  name: "list_pages",
  description:
    "List every page with its URL path, UUID, slug, parent page UUID, nesting depth, title, and template UUID (TOON rows). " +
    "Pages nest: a page's URL is its parent's URL + '/' + its slug (`/seo-monitoring/alerts` = slug 'alerts' under the '/seo-monitoring' page); depth 1 = top level. Pass `underPageId` to list one section's subtree. Inside a chat, paths show the chat's pending moves. " +
    "Standard list params: `filter` (substring across all columns), `limit`/`offset` (pagination), `full: true` (no truncation). " +
    "Use when you need a page UUID that isn't in the `# All pages` context block — the block is a turn-start snapshot, this is live. DO NOT ask the operator to paste a UUID.",
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
    { key: "templateId", value: (p) => p.templateId },
  ],
  emptyMessage:
    "No pages on this site yet. Call build_page (pass page.templateId from list_templates; modules:[] for an empty shell) to create one.",
});
