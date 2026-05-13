// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_pages`. AI-callable wrapper around `pages.list`.
 *
 * The `# All pages on this site` system-prompt block already lists every
 * page with slug + locale + UUID per turn. This tool gives the AI an
 * explicit fetch path for the same data — useful immediately after
 * create_page returns and the AI needs to chain another tool that takes
 * the new pageId, or when the AI claims it doesn't have a page UUID it
 * could see in the context block.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listPagesInput = z
  .object({
    includeDeleted: z.boolean().default(false),
    locale: z.string().optional(),
  })
  .strict();
type ListPagesInput = z.infer<typeof listPagesInput>;

export const listPagesTool: ToolDefinitionWithHandler<ListPagesInput> = {
  name: "list_pages",
  description:
    "List every page on the site with its UUID, slug, locale, title, and template UUID. " +
    "Optionally filter by locale. " +
    "Use when you need a page UUID and don't see it in the `# All pages on this site` context block " +
    "(e.g. right after create_page returned — the tool result includes the new pageId, but if you've lost it across loops, fetch via this tool). " +
    "DO NOT ask the operator to paste a UUID — call this tool.",
  schema: listPagesInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeDeleted: { type: "boolean", default: false },
      locale: { type: "string", maxLength: 16 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", input);
    if (!r.ok) {
      return { ok: false, content: `pages.list failed: ${describeError(r.error)}` };
    }
    const pages = (
      r.value as {
        pages: { id: string; slug: string; locale: string; title: string; templateId: string }[];
      }
    ).pages;
    if (pages.length === 0) {
      return {
        ok: true,
        content:
          "No pages on this site yet. Call create_page (pass templateId from list_templates) to create one.",
      };
    }
    const lines = pages.map(
      (p) =>
        `- /${p.slug} (id=${p.id}, locale=${p.locale}) "${p.title}" → templateId=${p.templateId}`,
    );
    return {
      ok: true,
      content: `${pages.length} page${pages.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    };
  },
};
