// SPDX-License-Identifier: MPL-2.0

/**
 * `bug_report` — the AI's defect channel (2026-07).
 *
 * Live-e2e forensics keep showing the AI correctly diagnosing product
 * bugs mid-task and then routing around them silently (run B4: the
 * selector-scoped screenshot returned the full page instead of a crop;
 * the AI noticed, said so in prose, switched to inspect_page_render —
 * and the diagnosis survived only in a debug wire log). This tool turns
 * that moment into a persisted, triageable row: report once, keep
 * working when a workaround exists, abort only when truly blocked.
 *
 * Always loaded (CORE_TOOL_NAMES): a bug can surface at any moment, and
 * an AI that first has to tool-search for the reporting channel while
 * confused defeats the purpose.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const bugReportToolInput = z
  .object({
    title: z.string().min(1).max(200),
    whatHappened: z.string().min(1).max(4000),
    expected: z.string().min(1).max(4000),
    suspectedTool: z.string().max(200).optional(),
    evidence: z.string().max(8000).optional(),
    severity: z.enum(["blocking", "degraded", "cosmetic"]).default("degraded"),
    blockedTask: z.boolean().default(false),
  })
  .strict();

export type BugReportToolInput = z.infer<typeof bugReportToolInput>;

export const bugReportTool: ToolDefinitionWithHandler<BugReportToolInput> = {
  name: "bug_report",
  description:
    "File a bug report against Caelo ITSELF when a tool or surface behaves contrary to its documented contract — e.g. a tool result contradicts persisted state, a screenshot/render ignores a parameter, an error fires on input the description says is valid. " +
    "This is for defects in the SYSTEM, not for your own mistakes (wrong arguments, misread state) and not for content/design issues on the site being built. " +
    "Report ONCE per distinct defect (do not re-file the same bug in one session), then CONTINUE the task via a workaround when one exists. Only when the bug genuinely blocks the task: file with blockedTask=true, tell the operator in one sentence what is blocked, and stop that line of work instead of retrying into the same wall. " +
    "`whatHappened` = what you observed (include the exact tool + arguments); `expected` = what the tool's contract promised; `evidence` = the result excerpt that proves it.",
  schema: bugReportToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "whatHappened", "expected"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      whatHappened: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "What you observed, incl. the exact tool + arguments used.",
      },
      expected: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "What the tool's description / the system's contract promised instead.",
      },
      suspectedTool: { type: "string", maxLength: 200 },
      evidence: {
        type: "string",
        maxLength: 8000,
        description: "Result/render excerpt that shows the mismatch.",
      },
      severity: {
        type: "string",
        enum: ["blocking", "degraded", "cosmetic"],
        description: "blocking = no workaround; degraded = worked around; cosmetic = noise only.",
      },
      blockedTask: {
        type: "boolean",
        description: "true ONLY when you had to abandon the current task because of this bug.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_bug_reports.create", {
      chatSessionId: toolCtx.chatSessionId ?? null,
      title: input.title,
      whatHappened: input.whatHappened,
      expected: input.expected,
      suspectedTool: input.suspectedTool ?? null,
      evidence: input.evidence ?? null,
      severity: input.severity,
      blockedTask: input.blockedTask,
    });
    if (!r.ok) {
      return { ok: false, content: `ai_bug_reports.create failed: ${describeError(r.error)}` };
    }
    const id = (r.value as { id: string }).id;
    return {
      ok: true,
      content:
        `Bug report ${id} recorded (${input.severity}${input.blockedTask ? ", task blocked" : ""}). ` +
        (input.blockedTask
          ? "Tell the operator in one sentence what is blocked, then stop this line of work."
          : "Continue the task with your workaround — do not re-file this defect."),
    };
  },
};
