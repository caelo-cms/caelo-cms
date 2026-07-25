// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: list_page_assets. The COMPLETE, searchable asset inventory of a
 * crawled import run — the full list behind inspect_external_page's top-20
 * `images` glance. Runs the same comprehensive discovery (img src+srcset,
 * CSS url(...), video/audio/source) over the run's STORED page HTML and
 * returns every distinct asset URL, ranked by prominence, optionally
 * narrowed to one page and/or a substring search. Feed the URLs you want
 * to import_media_from_urls.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listPageAssetsInput = z
  .object({
    runId: z.string().uuid(),
    pageUrl: z.string().url().optional(),
    search: z.string().min(1).max(400).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const listPageAssetsTool: ToolDefinitionWithHandler<z.infer<typeof listPageAssetsInput>> = {
  name: "list_page_assets",
  description:
    "List/search EVERY asset URL (images, CSS backgrounds, video/audio/source) discovered in a crawled import run's stored page HTML — the COMPLETE inventory behind inspect_external_page's top-20 `images` glance. " +
    "Use when the top-20 isn't enough, or to find assets by substring across a run's pages. " +
    "Pass `runId` (required); narrow with `pageUrl` (one crawled page) and/or `search` (case-insensitive URL substring); paginate with `limit`/`offset`. " +
    "Results are ranked by prominence (frequency of appearance). Then import the ones you need with import_media_from_urls({ urls: [...] }).",
  schema: listPageAssetsInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: {
      runId: { type: "string", format: "uuid", description: "The crawled import run to scan." },
      pageUrl: {
        type: "string",
        format: "uri",
        description: "Optional — restrict to one crawled page by its exact source URL.",
      },
      search: {
        type: "string",
        description: "Optional case-insensitive substring the asset URL must contain.",
      },
      limit: { type: "number", description: "Max assets to return (default 200, max 500)." },
      offset: { type: "number", description: "Pagination offset (default 0)." },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.list_page_assets",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `imports.list_page_assets failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      total: number;
      pagesScanned: number;
      assets: Array<{ url: string; count: number; pages: number; alt: string | null }>;
    };
    if (v.assets.length === 0) {
      return {
        ok: true,
        content:
          `No assets matched${input.search ? ` search "${input.search}"` : ""} across ${v.pagesScanned} scanned page(s). ` +
          "If the run's pages have not been crawled/extracted yet, there is no stored HTML to scan.",
      };
    }
    const lines = [
      `${v.total} distinct asset(s) across ${v.pagesScanned} crawled page(s)${input.search ? ` matching "${input.search}"` : ""} (showing ${v.assets.length}):`,
      ...v.assets.map(
        (a) =>
          `- ${a.url} (×${a.count} on ${a.pages} page${a.pages === 1 ? "" : "s"})${a.alt ? ` (alt="${a.alt}")` : ""}`,
      ),
      "Import the ones you need with import_media_from_urls({ urls: [...] }).",
    ];
    return { ok: true, content: lines.join("\n") };
  },
};
