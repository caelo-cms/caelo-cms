// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1275 — `retry_tool_call`: fix a kept failed write call with a
 * patch instead of resending it.
 *
 * A write call that failed with a fixable error is kept with its
 * `chat_tool_results` row (`_retry-keep.ts`). This tool claims the row
 * (atomic: one of two parallel retries wins), applies the patch
 * (`_retry-patch.ts`) and re-dispatches the patched call through
 * {@link ToolRegistry.dispatch} in the CURRENT context: permissions, the
 * Zod parse, the op's validation, locks, snapshots, audit and
 * `needsApproval` all run again on the patched arguments, so a patch that
 * crosses an approval threshold queues the approval. There is no new
 * trust path — the retry is an ordinary call whose arguments came from
 * the kept row instead of the model.
 *
 * Branch binding: the dispatch uses the chat's binding at retry time (the
 * chat-runner re-reads it per call), so a call kept on the shared draft
 * retries wherever the chat is bound now. A subagent retries only its own
 * session's calls (the row is looked up by the dispatching session), and
 * only the actor a call was kept for reads it back (RLS, migration 0449).
 *
 * Outcome: success clears the kept arguments; a failure that is still
 * kept stores the PATCHED arguments, so the next patch builds on this one
 * and the same id stays retryable; any other failure drops the kept call.
 */

import { type ErrorDetail, execute, formatErrorDetails } from "@caelo-cms/query-api";
import { z } from "zod";
import { keptCallArgs, RETRY_TOOL_NAME, withKeptCallNotice } from "./_retry-keep.js";
import { applyRetryPatch } from "./_retry-patch.js";
import type { ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";
import { liveToolNameFor } from "./retired-tools.js";

const pathSchema = z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1);

const retryToolCallInput = z
  .object({
    toolCallId: z.string().min(1).max(200),
    set: z
      .array(z.object({ path: pathSchema, value: z.unknown() }).strict())
      .max(100)
      .optional(),
    remove: z.array(pathSchema).max(100).optional(),
    replace: z
      .array(z.object({ path: pathSchema, old: z.string().min(1), new: z.string() }).strict())
      .max(100)
      .optional(),
  })
  .strict();

type RetryToolCallInput = z.infer<typeof retryToolCallInput>;

const PATH_JSON_SCHEMA = {
  type: "array",
  minItems: 1,
  items: { type: ["string", "integer"] },
  description: 'Segment array as the error names it, e.g. ["modules",3,"html"].',
};

/** Why a call cannot be claimed, as the AI's next step. */
const CLAIM_REFUSAL: Record<string, string> = {
  unknown:
    "no kept call with this toolCallId in this chat — only a failed write call whose result named retry_tool_call can be retried; send the call itself instead",
  succeeded: "this call already succeeded (a retry fixed it) — nothing to retry",
  "not-kept":
    "this call was not kept for a patch (its failure is not fixable by changing the call, or it was a read / gated tool) — send a new call if it still needs doing",
  "in-progress":
    "this call is already being retried — wait for that result instead of retrying it twice",
};

function failed(content: string, errors?: readonly ErrorDetail[]): ToolResult {
  return {
    ok: false,
    content,
    failureKind: "InvalidArguments",
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

export const retryToolCallTool: ToolDefinitionWithHandler<RetryToolCallInput> = {
  name: RETRY_TOOL_NAME,
  description:
    "Fix a failed write call with a small patch instead of resending it — only for a call whose result names `retry_tool_call`. " +
    'Paths are segment arrays exactly as the error names them (`["page","pageType"]`, `["modules",3,"html"]`). ' +
    "`set` writes a value, `remove` drops a key or array entry, `replace` swaps one exact text inside one string (must match once). " +
    "The patched call runs as a new call (permissions, validation, approval re-checked); if it fails again, patch the same toolCallId again.",
  schema: retryToolCallInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["toolCallId"],
    properties: {
      toolCallId: { type: "string", description: "The failed call's id, from its result." },
      set: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "value"],
          properties: { path: PATH_JSON_SCHEMA, value: {} },
        },
      },
      remove: { type: "array", items: PATH_JSON_SCHEMA },
      replace: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "old", "new"],
          properties: { path: PATH_JSON_SCHEMA, old: { type: "string" }, new: { type: "string" } },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const { registry, adapter, chatSessionId, tools } = toolCtx;
    const ownerCtx = toolCtx.humanCtx;
    if (!registry || !adapter || !chatSessionId || !tools || !ownerCtx) {
      return {
        ok: false,
        content:
          "retry_tool_call works inside a chat session (Power-MCP: caelo_open_session first) — send the call itself here.",
      };
    }
    const ids = { chatSessionId, toolCallId: input.toolCallId };
    const claim = await execute(registry, adapter, ownerCtx, "chat.claim_tool_call_retry", ids);
    if (!claim.ok) {
      return {
        ok: false,
        content: "the kept call could not be read — a defect in Caelo, reported automatically",
        failureKind: "internal",
      };
    }
    const claimed = claim.value as {
      claimed: { toolName: string; args: Record<string, unknown> } | null;
      reason: string | null;
    };
    if (!claimed.claimed) {
      const refused: ErrorDetail[] = [
        {
          path: ["toolCallId"],
          message: CLAIM_REFUSAL[claimed.reason ?? "unknown"] ?? CLAIM_REFUSAL.unknown ?? "",
        },
      ];
      return failed(formatErrorDetails(refused), refused);
    }
    const release = () => execute(registry, adapter, ownerCtx, "chat.finish_tool_call_retry", ids);

    const patched = applyRetryPatch(claimed.claimed.args, input);
    if (!patched.ok) {
      await release();
      return failed(
        `The patch did not apply; the kept call is unchanged. ${formatErrorDetails(patched.errors)}`,
        patched.errors,
      );
    }

    const toolName = liveToolNameFor(claimed.claimed.toolName);
    let result: ToolResult;
    try {
      result = await tools.dispatch(toolName, patched.args, ctx, toolCtx);
    } catch (thrown) {
      await release();
      throw thrown;
    }
    const keep = result.ok ? null : keptCallArgs(result, tools);
    const shown = keep ? withKeptCallNotice(input.toolCallId, result) : result;
    await execute(registry, adapter, ownerCtx, "chat.finish_tool_call_retry", {
      ...ids,
      outcome: { toolName, ok: shown.ok, content: shown.content, args: keep },
    });
    // The retry's own result: the re-dispatched call's, without `call` —
    // the kept row is the original id's, never this retry call's. The note
    // is APPENDED: a queued approval's content must keep its canonical
    // "Queued proposal <uuid>:" start (ProposeCard, the Power-MCP hand-off).
    const { call: _call, ...rest } = shown;
    const note = result.ok
      ? `(retry of ${toolName} call ${input.toolCallId})`
      : keep
        ? ""
        : `(retry of ${toolName} call ${input.toolCallId}; this failure is not fixable by a patch, so the call is no longer kept)`;
    return { ...rest, content: note ? `${shown.content}\n${note}` : shown.content };
  },
};
