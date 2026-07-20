// SPDX-License-Identifier: MPL-2.0

/**
 * `read_page_more` — paginate the Markdown of a page already fetched by
 * `inspect_external_page`, via its `pageRef` handle. No re-fetch: it
 * reads the cached inspection (docs/inspect-tooling-redesign.md §3). The
 * gist facet returns the first slice + a cursor; this returns the rest,
 * slice by slice.
 */

import { z } from "zod";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import {
  getPageInspection,
  MARKDOWN_SLICE_CHARS,
  sliceMarkdown,
} from "./_page-inspection-cache.js";

const readPageMoreInput = z
  .object({
    pageRef: z.string().min(1),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ReadPageMoreInput = z.infer<typeof readPageMoreInput>;

export const readPageMoreTool: ToolDefinitionWithHandler<ReadPageMoreInput> = {
  name: "read_page_more",
  description:
    "Continue reading the Markdown of a page you already fetched with inspect_external_page — pass its `pageRef` handle and the `cursor` from the previous slice's truncation note. Reuses the cached page (NO re-fetch, no extra fetch-budget cost). Returns the next " +
    `${MARKDOWN_SLICE_CHARS}-char slice plus the next cursor (or a done marker). If the handle has expired, re-run inspect_external_page.`,
  schema: readPageMoreInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageRef"],
    properties: {
      pageRef: {
        type: "string",
        description: "The page handle returned by inspect_external_page (e.g. pg_abc123).",
      },
      cursor: {
        type: "integer",
        minimum: 0,
        description: "Char offset to continue from (the value in the previous slice's truncation note). Omit to start at 0.",
      },
    },
  },
  handler: async (_ctx, input) => {
    const entry = getPageInspection(input.pageRef);
    if (!entry) {
      return {
        ok: false,
        content: `read_page_more: page handle "${input.pageRef}" is not cached (expired or never inspected). Re-run inspect_external_page({ url }) to get a fresh handle.`,
      };
    }
    const cursor = input.cursor ?? 0;
    if (cursor >= entry.markdown.length) {
      return {
        ok: true,
        content: `(read_page_more: cursor ${cursor} is at or past the end of ${entry.url} — nothing more to read.)`,
      };
    }
    const { text, nextCursor } = sliceMarkdown(entry.markdown, cursor);
    const tail =
      nextCursor !== null
        ? `\n\n[more — call read_page_more({ pageRef: "${input.pageRef}", cursor: ${nextCursor} }) for the next slice.]`
        : "\n\n[end of page.]";
    return {
      ok: true,
      content: `## Page text (Markdown) — ${entry.url} [from char ${cursor}]\n${text}${tail}`,
    };
  },
};
