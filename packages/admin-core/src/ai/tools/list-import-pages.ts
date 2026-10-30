// SPDX-License-Identifier: MPL-2.0

/**
 * issue #422 — the id-bearing list surface for a crawl run's pages.
 *
 * Before this tool the AI could not obtain an `import_pages.id` anywhere:
 * `get_import_page` needed an id to be called at all, error strings pointed
 * at `imports.get` (a Query API op with no AI tool), and everything
 * downstream of the id — build_page linkage, the content-inventory check,
 * page notes, the run report's rebuilt counter — failed or degraded to
 * render-greps. This is the §11 list op for the import domain: run status
 * (the crawl-polling surface the skills reference) + one lean row per page
 * with the id every sibling tool takes. Never returns the crawled HTML.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z
  .object({
    runId: z.string().uuid(),
    status: z.enum(["pending", "accepted", "rejected"]).optional(),
    search: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
type Input = z.infer<typeof input>;

interface ListResult {
  run: {
    id: string;
    status: string;
    sourceUrl: string;
    pagesSeen: number;
    pagesExtracted: number;
    errorMessage: string | null;
  };
  total: number;
  pages: {
    id: string;
    sourceUrl: string;
    proposedSlug: string;
    proposedTitle: string | null;
    status: "pending" | "accepted" | "rejected";
    acceptedPageId: string | null;
    clusterKey: string | null;
    clusterLabel: string | null;
    hasScreenshot: boolean;
  }[];
}

export const listImportPagesTool: ToolDefinitionWithHandler<Input> = {
  name: "list_import_pages",
  description:
    "List a crawl run's status + its pages with `importPageId` (the id every per-page import tool takes), source url, proposed slug/title, rebuild status, built page id — never crawled HTML (-> `get_import_page`).\n" +
    "USE FOR:\n" +
    "- Polling after the operator approves `propose_site_import`: run `crawling` -> wait, re-check; continue at `ready_for_review`.\n" +
    "- Before rebuilding: `importPageId` for `get_import_page`, `build_page` `page.importPageId` (links the build for verification + run report), `check_page_content_inventory`, `get_import_page_screenshot`, `add_import_page_notes`.\n" +
    "Never guess or reuse ids from other runs.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: {
      runId: {
        type: "string",
        format: "uuid",
        description: "From `propose_site_import`'s approval.",
      },
      status: {
        type: "string",
        enum: ["pending", "accepted", "rejected"],
        description:
          "`pending` not yet rebuilt | `accepted` linked to a built page | `rejected` declined by the operator.",
      },
      search: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description:
          "Find a page: case-insensitive substring over source url, proposed slug, title.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description:
          "Default 200. Raise for crawls >200 pages; the result names the matched total.",
      },
    },
  },
  handler: async (ctx, toolInput, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.list_pages",
      toolInput,
    );
    if (!r.ok) {
      return toolError(r.error, `list_import_pages failed: ${describeError(r.error)}`);
    }
    const v = r.value as ListResult;
    const lines = [
      `# Import run ${v.run.sourceUrl} — status: ${v.run.status} (${v.run.pagesExtracted} extracted of ${v.run.pagesSeen} URLs seen)`,
    ];
    if (v.run.errorMessage) lines.push(`Run error: ${v.run.errorMessage}`);
    if (v.run.status === "crawling" || v.run.status === "proposed") {
      lines.push(
        "The crawl has not finished — tell the operator in one sentence, wait, and re-check; continue the moment it reaches ready_for_review.",
      );
    }
    if (v.pages.length === 0) {
      lines.push(
        v.total === 0
          ? "No pages match. During a crawl the rows appear as pages are extracted; with a filter, loosen it."
          : `0 of ${v.total} matching pages shown — narrow the search.`,
      );
    } else {
      lines.push(
        "",
        `${v.pages.length}${v.total > v.pages.length ? ` of ${v.total}` : ""} page(s) — importPageId | status | proposed slug | source url:`,
      );
      for (const p of v.pages) {
        const cluster = p.clusterLabel ?? p.clusterKey;
        lines.push(
          `- ${p.id} | ${p.status} | /${p.proposedSlug} | ${p.sourceUrl}` +
            (p.acceptedPageId ? ` | built page ${p.acceptedPageId}` : "") +
            (cluster ? ` | type: ${cluster}` : "") +
            (p.hasScreenshot ? "" : " | NO source screenshot (unverified)"),
        );
      }
      lines.push(
        "",
        "Use each importPageId with get_import_page / build_page (page.importPageId) / check_page_content_inventory / add_import_page_notes.",
      );
    }
    return { ok: true, content: lines.join("\n") };
  },
};
