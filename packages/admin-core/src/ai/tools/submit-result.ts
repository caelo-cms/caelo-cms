// SPDX-License-Identifier: MPL-2.0

/**
 * Run #10 D2 — `submit_result`: the structured final-answer channel for
 * subagent sessions.
 *
 * Run #10's rebuild fan-out lost all 5 subagent spawns to the free-text
 * result channel: children did 77-248s of real tool work, then either
 * ended the turn with NO trailing text ("returned empty text") or their
 * final text wasn't the JSON the parent expected ("response is not
 * valid JSON" — one child's own context-limit error string was parsed
 * as its output). Hoping the model's LAST text block happens to be
 * well-formed JSON is structurally fragile; a tool call is the channel
 * models reliably emit.
 *
 * The tool only exists inside child sessions: the chat-runner adds it
 * to the excluded set unless `ChatRunnerOptions.subagentResultCapture`
 * is present (see index.ts), and the handler double-checks the capture
 * on ToolContext so a stray dispatch outside a subagent refuses loudly.
 * Validation runs against the SAME shared Zod shapes the free-text
 * parser uses, so a shape mismatch bounces back to the child as a
 * failed tool result it can fix in-loop — one more provider turn, no
 * parent round-trip.
 */

import { validateSubagentResultValue } from "@caelo-cms/shared";
import { z } from "zod";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const submitResultToolInput = z
  .object({
    result: z.unknown(),
  })
  .strict();
export type SubmitResultToolInput = z.infer<typeof submitResultToolInput>;

export const submitResultTool: ToolDefinitionWithHandler<SubmitResultToolInput> = {
  name: "submit_result",
  description:
    "SUBAGENT FINAL ANSWER — call this tool exactly once, as your LAST action, to deliver your result to the parent agent. " +
    'Pass your result under the `result` key, matching the return-shape contract stated in your task (e.g. {"result": {"pages": [...], "summary": "..."}} for a rebuild task, ' +
    '{"result": {"pass": true, "issues": []}} for a verdict task, or {"result": {"text": "..."}} / {"result": "..."} for freeform). ' +
    "Your result is ONLY read from this tool call — plain text at the end of your turn is NOT collected. " +
    "If this tool rejects your payload, fix the named fields and call it again. After it succeeds, end your turn.",
  schema: submitResultToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["result"],
    properties: {
      result: {
        // Polymorphic: an object for verdict/tree/rebuild shapes, a bare
        // string for freeform. Declaring the object/array types is what
        // lets the #251 encoding-repair layer (normalize-args) JSON-decode
        // a provider that double-encodes the payload as a string
        // (`{"result":"{\"pass\":true,...}"}`) BEFORE it hits shape
        // validation — otherwise a verdict arrives as a raw string and is
        // rejected as "string (scalar)". A genuine freeform prose string
        // (not starting with `{`/`[`) is left untouched by the repair.
        type: ["object", "array", "string"],
        description:
          "The final result payload, matching the return-shape contract given in the task brief.",
      },
    },
  },
  handler: async (_ctx, input, toolCtx) => {
    const capture = toolCtx.subagentResultCapture;
    if (!capture) {
      // Catalogue gating should make this unreachable in a normal chat;
      // refuse loudly rather than silently swallowing a result nobody
      // is listening for (CLAUDE.md §2 no-fallbacks).
      return {
        ok: false,
        content:
          "submit_result is only available inside a spawned subagent session — there is no parent waiting for a structured result here. Reply to the operator directly instead.",
      };
    }
    if (input.result === undefined) {
      return {
        ok: false,
        content:
          'submit_result requires a `result` key: {"result": <payload matching the return-shape contract in your task>}. Call it again with the payload.',
      };
    }
    const validated = validateSubagentResultValue(input.result, capture.expectedShape);
    if (!validated.ok) {
      return {
        ok: false,
        content: `submit_result rejected: ${validated.error}. Fix the payload and call submit_result again.`,
      };
    }
    capture.submit(validated.value);
    return {
      ok: true,
      content:
        "Result recorded for the parent agent. End your turn now with a one-line confirmation — do not call further tools.",
    };
  },
};
