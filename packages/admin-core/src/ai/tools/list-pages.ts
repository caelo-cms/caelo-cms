// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_pages`: the AI's read path for pages (the system prompt
 * carries no page list, CLAUDE.md §11), as TOON rows.
 *
 * #1269 — it reads what it returns, never the whole site: one page of the
 * site at a time (`pages.list` with `limit` + `cursor`), or a search
 * (`pages.search`: the words given start words of a page's title or path).
 * On a 50,000-page site the old list-everything-then-filter read every
 * page and its ancestry on every call.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import { renderToonList, rowsWithinCharCap, type ToonColumn } from "./_list-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { generateInputSchema } from "./generate-input-schema.js";

/** Pages one call returns when the model passes no `limit`. */
const DEFAULT_LIMIT = 50;

const listPagesInput = z
  .object({
    search: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Words that start words of the page\'s title or path, e.g. "pricing" or "blog launch" (the last word names the page itself). Searches the whole site.',
      ),
    underPageId: z
      .string()
      .uuid()
      .optional()
      .describe("Only this page's subtree (not with search)."),
    includeDeleted: z.boolean().optional().describe("Also deleted pages (not with search)."),
    limit: z.number().int().min(1).max(200).optional().describe(`Default ${DEFAULT_LIMIT}.`),
    cursor: z
      .string()
      .min(1)
      .max(400)
      .optional()
      .describe("`next cursor` of the previous call, with the same search / underPageId."),
  })
  .strict();

type ListPagesInput = z.infer<typeof listPagesInput>;

interface ListedPage {
  id: string;
  slug: string;
  currentPath: string;
  parentPageId: string | null;
  depth: number;
  title: string;
  shortTitle: string;
  templateId: string;
  pageType: string;
}

const columns: readonly ToonColumn<ListedPage>[] = [
  { key: "path", value: (p) => p.currentPath },
  { key: "id", value: (p) => p.id },
  { key: "slug", value: (p) => p.slug },
  { key: "parentId", value: (p) => p.parentPageId ?? "" },
  { key: "depth", value: (p) => String(p.depth) },
  { key: "title", value: (p) => p.title },
  { key: "shortTitle", value: (p) => p.shortTitle },
  { key: "pageType", value: (p) => p.pageType },
  { key: "templateId", value: (p) => p.templateId },
];

/** What the model reads when a call returns no row. */
function emptyAnswer(input: ListPagesInput, nextCursor: string | null): string {
  if (input.search !== undefined) {
    return nextCursor
      ? `No match yet among the pages looked at for "${input.search}"; call again with cursor: ${nextCursor}`
      : `No page matches "${input.search}": the words must start words of a page's title or path (the last word names the page itself). Try fewer or other words, or list pages without search.`;
  }
  // A batch the chat's pending deletes emptied: more pages may follow.
  if (nextCursor) return `No visible page in this batch; call again with cursor: ${nextCursor}`;
  if (input.cursor) return "No more pages.";
  return "No pages on this site yet. Call build_page (pass page.templateId from list_templates; modules:[] for an empty shell) to create one.";
}

export const listPagesTool: ToolDefinitionWithHandler<ListPagesInput> = {
  name: "list_pages",
  description:
    "List pages (TOON rows): path, UUID, slug, parent UUID, depth (1 = top level), title, short title (breadcrumb/navigation label), page type (what the page IS, e.g. `news`; `list_page_types`), template UUID. URL = parent URL + '/' + slug. Inside a chat, paths show its pending moves. To find a page, pass `search` with words of its title or path; without it, rows come one page of the site at a time (follow `next cursor` to browse a small site or a subtree, never to scan a large one). Use for any page UUID/path; never ask the operator to paste a UUID.",
  schema: listPagesInput,
  inputSchema: generateInputSchema(listPagesInput),
  handler: async (ctx, input, toolCtx) => {
    if (input.search !== undefined && (input.underPageId || input.includeDeleted)) {
      return {
        ok: false,
        content:
          "search finds pages anywhere on the site and cannot be combined with underPageId or includeDeleted: pass search alone, or list the subtree without search.",
      };
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    const cursor = input.cursor ? { cursor: input.cursor } : {};
    const opName = input.search !== undefined ? "pages.search" : "pages.list";
    const opInput = (n: number) =>
      input.search !== undefined
        ? { query: input.search, limit: n, ...cursor }
        : {
            limit: n,
            ...cursor,
            ...(input.underPageId ? { underPageId: input.underPageId } : {}),
            ...(input.includeDeleted ? { includeDeleted: true } : {}),
          };
    const read = async (n: number) => {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, opName, opInput(n));
      return r.ok
        ? {
            ok: true as const,
            value: r.value as { pages: ListedPage[]; nextCursor: string | null },
          }
        : r;
    };
    let r = await read(limit);
    if (!r.ok) return toolError(r.error, `${opName} failed: ${describeError(r.error)}`);
    if (r.value.pages.length === 0) {
      return { ok: true, content: emptyAnswer(input, r.value.nextCursor) };
    }
    // The chat's context stays bounded: when the rows outgrow the list char
    // cap, read the page again with exactly as many rows as fit, so its
    // cursor continues right after the last row shown (it is opaque, the
    // tool cannot shorten it itself).
    const fit = rowsWithinCharCap(r.value.pages, columns);
    if (fit < r.value.pages.length) {
      r = await read(Math.max(1, fit));
      if (!r.ok) return toolError(r.error, `${opName} failed: ${describeError(r.error)}`);
    }
    const { pages, nextCursor } = r.value;
    const rows = renderToonList("pages", pages, columns, { full: true });
    const next = nextCursor ? `\n# more exist; next cursor: ${nextCursor}` : "";
    return { ok: true, content: `${rows}${next}`, value: r.value };
  },
};
