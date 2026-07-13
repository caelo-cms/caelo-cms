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
    "Record WHY you just changed a page, in the page's durable log — so a future chat or a fresh subagent that touches this page knows the intent without re-reading this whole conversation. Call it after a MEANINGFUL change: a design/structure decision you made and why (entryKind 'decision'), an operator answer that shaped the page ('operator_answer'), a full rebuild ('rebuilt'), a substantive content/module edit ('edited'), something still unresolved a later turn must settle ('open_question'), or any other durable note ('note'). Keep `summary` to one sentence in plain words; put structured extras (chosen option, the operator's exact words, affected module ids) in `detail` as an object. Do NOT log routine no-ops or narrate every tool call — one entry per real decision. This is append-only work history; it is never reviewed or reverted.",
  schema: pageLogAppendInputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "entryKind", "summary"],
    properties: {
      pageId: { type: "string", format: "uuid", description: "The page this entry is about." },
      entryKind: {
        type: "string",
        enum: ["edited", "decision", "operator_answer", "open_question", "rebuilt", "note"],
        description:
          "edited = substantive content/module change; decision = a call you made + rationale; operator_answer = an answer the operator gave that shaped the page; open_question = still unresolved; rebuilt = rebuilt from scratch; note = anything else worth preserving.",
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "One plain sentence: what happened / was decided and why.",
      },
      detail: {
        type: "object",
        description:
          "Optional structured context as an OBJECT (not a scalar): chosen option, operator's exact words, affected module ids, etc.",
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
