// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — the AI's write surface onto the per-page LOG. After a
 * meaningful change to a page (a decision, an operator answer, a rebuild),
 * the AI records WHY in one line so a future chat or a fresh subagent that
 * touches the page builds on that intent instead of dragging this chat's
 * whole transcript through its context. The read side is `get_page_log`.
 */

import { execute } from "@caelo-cms/query-api";
import { type PageLogAppendInput, pageLogAppendInputSchema } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const logPageEditTool: ToolDefinitionWithHandler<PageLogAppendInput> = {
  name: "log_page_edit",
  description:
    "Append WHY you changed a page to its durable log, so later chats/subagents know the intent without this conversation. Call after a MEANINGFUL change only — one entry per real decision; no routine no-ops or per-tool-call narration. Append-only; never reviewed or reverted.",
  schema: pageLogAppendInputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "entryKind", "summary"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      entryKind: {
        type: "string",
        enum: ["edited", "decision", "operator_answer", "open_question", "rebuilt", "note"],
        description:
          "edited = substantive content/module change | decision = your call + rationale | operator_answer = operator answer that shaped the page | open_question = unresolved, a later turn must settle | rebuilt = from scratch | note = other durable note.",
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "One plain sentence: what happened/was decided and why.",
      },
      detail: {
        type: "object",
        description:
          "Structured extras as an OBJECT (not scalar): chosen option, operator's exact words, affected module ids.",
        additionalProperties: true,
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "page_log.append", input);
    if (!r.ok) {
      return { ok: false, content: `log_page_edit failed: ${describeError(r.error)}` };
    }
    return { ok: true, content: `Logged (${input.entryKind}) on the page.` };
  },
};
