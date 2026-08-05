// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 — read ONE crawled page's captured content for a build_page rebuild,
 * mirroring `inspect_external_page` but sourced from the STORED crawl (no
 * re-fetch). Returns the GIST — Markdown text + design tokens + a source-
 * screenshot handle + a `pageRef` for query_page_html/read_page_more — and
 * NEVER the raw `proposed_modules` HTML. A page's legacy page-builder markup
 * (Elementor/WPBakery/Divi div-soup) is hundreds of KB of context bloat and
 * the flow authors fresh semantic modules anyway; the same reasoning retired
 * inspect_external_page's `markup` facet in 0174. The op returns the assembled
 * HTML to this tool only, which converts it to Markdown, caches it under a
 * pageRef (shared in-process with the inspect tools), and surfaces only the
 * gist to the model.
 */

import { execute } from "@caelo-cms/query-api";
import { htmlToMarkdown } from "@caelo-cms/site-importer";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { putPageInspection, sliceMarkdown } from "./_page-inspection-cache.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z.object({ importPageId: z.string().uuid() }).strict();
type Input = z.infer<typeof input>;

interface Gist {
  importPageId: string;
  runId: string;
  sourceUrl: string | null;
  proposedSlug: string | null;
  proposedTitle: string | null;
  html: string;
  themeTokens: unknown;
  sampledDesignTokens: unknown;
  screenshotObjectKey: string | null;
}

export const getImportPageTool: ToolDefinitionWithHandler<Input> = {
  name: "get_import_page",
  description:
    "Read ONE page's captured content from a completed crawl run as the GIST — the page text as Markdown, the crawled design tokens, and a source-screenshot handle — so you can rebuild it with build_page WITHOUT re-fetching the live site. It NEVER returns the source's raw page-builder HTML (that div-soup is context bloat, and you author fresh semantic modules regardless). Returns: proposed slug + title; the text as Markdown (truncated with a cursor — call read_page_more for the rest); the crawled design tokens (colors/fonts — cite THESE, don't guess); and a `pageRef` so query_page_html can pull ONE specific section of the stored HTML on demand. For the visual, call get_import_page_screenshot. Pass the staging import_pages id (from list_import_pages), the built page id, or a built page whose slug matches the crawl; the result always echoes the resolved staging id for the follow-up calls. Use this in the mass-import step to rebuild each crawled page; for a live URL not in a crawl use inspect_external_page instead.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["importPageId"],
    properties: {
      importPageId: {
        type: "string",
        format: "uuid",
        description:
          "The staging import_pages.id, the built CMS page id, or a slug-matched built page.",
      },
    },
  },
  handler: async (ctx, toolInput, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.get_page_gist", {
      importPageId: toolInput.importPageId,
    });
    if (!r.ok) {
      return { ok: false, content: `get_import_page failed: ${describeError(r.error)}` };
    }
    const g = r.value as Gist;
    const markdown = htmlToMarkdown(g.html);
    // Cache under a pageRef so query_page_html / read_page_more work on this
    // stored page exactly as they do on a live inspect_external_page result.
    const pageRef = putPageInspection(toolCtx.chatSessionId ?? "no-session", {
      url: g.sourceUrl ?? `import:${g.importPageId}`,
      html: g.html,
      markdown,
    });
    const { text, nextCursor } = sliceMarkdown(markdown, 0);
    const tokens = g.sampledDesignTokens ?? g.themeTokens ?? null;
    const sections = [
      `# Imported page — ${g.sourceUrl ?? g.importPageId}`,
      // issue #422 — always emit the RESOLVED staging id (even when the
      // caller passed a built page id): it is the one id every follow-up
      // call takes (build_page.importPageId, check_page_content_inventory,
      // add_import_page_notes, get_import_page_screenshot).
      `Import page id: ${g.importPageId} (run ${g.runId}) — pass this as build_page's page.importPageId and to the verification/notes tools.`,
      `Page handle: ${pageRef} — reuse with read_page_more({ pageRef, cursor }) / query_page_html({ pageRef, ... }); no re-fetch.`,
      `Proposed slug: ${g.proposedSlug ?? "(none)"}`,
      `Proposed title: ${g.proposedTitle ?? "(none)"}`,
      "",
      "## Page text (Markdown)",
      text.length > 0 ? text : "(no readable text captured for this page)",
      nextCursor !== null
        ? `\n[truncated — ${markdown.length - text.length} more chars. Call read_page_more({ pageRef, cursor: ${nextCursor} }) for the rest.]`
        : "",
      "",
      "## Design tokens (crawled ground truth — cite these, never guess a palette)",
      tokens ? JSON.stringify(tokens, null, 2).slice(0, 2000) : "(none captured on this run)",
      "",
      "## Source screenshot",
      g.screenshotObjectKey
        ? "Stored — LOOK at it with get_import_page_screenshot({ importPageId, which: 'source' }) before you rebuild."
        : "No stored source screenshot — this page is UNVERIFIED; say so, do not claim you saw it.",
      "",
      "Rebuild with build_page: author FRESH semantic modules from the Markdown + screenshot + tokens above — never reproduce the source's page-builder markup. For one specific structure (a table, a form, a spec list) pull it with query_page_html({ pageRef, describe: '…' }).",
    ];
    return { ok: true, content: sections.join("\n") };
  },
};
