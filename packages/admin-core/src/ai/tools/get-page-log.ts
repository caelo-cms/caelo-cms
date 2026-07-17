// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — the AI's read surface onto the per-page LOG. Before touching a
 * page (especially as a fresh subagent with no memory of the originating
 * chat), the AI calls this to see prior work — why the page was edited, what
 * decisions were taken, which operator answers shaped it, and what open
 * questions remain — so it builds on settled calls instead of re-litigating
 * them. Renders the `## Page log` block (CLAUDE.md §11 context-block pattern,
 * <2 KB); the write side is `log_page_edit`.
 */

import { execute } from "@caelo-cms/query-api";
import { formatPageLogBlock, type PageLogEntry } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const getPageLogInput = z
  .object({
    pageId: z.string().uuid(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
type GetPageLogInput = z.infer<typeof getPageLogInput>;

export const getPageLogTool: ToolDefinitionWithHandler<GetPageLogInput> = {
  name: "get_page_log",
  description:
    "Read a page's durable work-history log BEFORE you change it — why it was edited, decisions taken, operator answers, open questions. Essential when you start fresh on a page (e.g. a subagent with no memory of the chat that first built it): it hands you the intent without re-reading a whole prior conversation. Returns newest-first; pass `limit` to widen (default 20). Empty is normal for a page nobody has logged yet. After your own meaningful change, record it with `log_page_edit`.",
  schema: getPageLogInput,
  inputSchema: z.toJSONSchema(getPageLogInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "page_log.list", input);
    if (!r.ok) {
      return { ok: false, content: `get_page_log failed: ${describeError(r.error)}` };
    }
    const { entries } = r.value as { entries: PageLogEntry[] };
    const block = formatPageLogBlock(entries);
    if (block === null) {
      return { ok: true, content: "No log entries for this page yet." };
    }
    return { ok: true, content: block };
  },
};
