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
    locale: z.string().max(16).optional(),
  })
  .strict();

export const listPagesTool = makeListReadTool<
  z.infer<typeof listPagesInput>,
  { id: string; slug: string; locale: string; title: string; status?: string; templateId: string }
>({
  name: "list_pages",
  description:
    "List every page with UUID, slug, locale, title, and template UUID (TOON rows). " +
    "Optional `locale`, plus the standard list params: `filter` (substring across all columns), `limit`/`offset` (pagination), `full: true` (no truncation). " +
    "Use when you need a page UUID that isn't in the `# All pages` context block — the block is a turn-start snapshot, this is live. DO NOT ask the operator to paste a UUID.",
  opName: "pages.list",
  input: listPagesInput,
  label: "pages",
  rows: (value) =>
    (
      value as {
        pages: {
          id: string;
          slug: string;
          locale: string;
          title: string;
          status?: string;
          templateId: string;
        }[];
      }
    ).pages,
  columns: [
    { key: "slug", value: (p) => p.slug },
    { key: "id", value: (p) => p.id },
    { key: "locale", value: (p) => p.locale },
    { key: "title", value: (p) => p.title },
    { key: "templateId", value: (p) => p.templateId },
  ],
  emptyMessage:
    "No pages on this site yet. Call build_page (pass page.templateId from list_templates; modules:[] for an empty shell) to create one.",
});
