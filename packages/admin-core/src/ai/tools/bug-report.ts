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
 *
 * #902 — the result states where the report went (`forwardingState`). The
 * AI used to tell operators "I reported this to Caelo" when the row never
 * left the install; the result now carries the exact sentence it may use.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import type { BugForwardingState } from "../../ops/ai/bug-reports.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const BUG_REPORT_FIELDS = [
  "title",
  "whatHappened",
  "expected",
  "suspectedTool",
  "evidence",
  "severity",
  "blockedTask",
] as const;

/**
 * #644 — a value that carries this call's OTHER parameters as markup
 * (`…</evidence>\n<suspectedTool">translate_variant</suspectedTool>`).
 * A live run filed exactly that: the tool-call encoding bled the remaining
 * parameters into the open `evidence` string, so `suspectedTool` and
 * `severity` were lost and the excerpt ended in tag soup. Nothing in this
 * schema asks for markup; refusing the shape makes the AI re-file with each
 * value in its own field instead of persisting a half-parsed report.
 */
const LEAKED_PARAMETER_RE = new RegExp(
  // `title` is left out: a render excerpt legitimately quotes `<title>`.
  `</?(?:${BUG_REPORT_FIELDS.filter((f) => f !== "title").join("|")})\\b[^<>]*>`,
);

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
  .strict()
  .superRefine((input, issues) => {
    for (const field of BUG_REPORT_FIELDS) {
      const value = input[field];
      if (typeof value !== "string") continue;
      const leaked = LEAKED_PARAMETER_RE.exec(value);
      if (!leaked) continue;
      issues.addIssue({
        code: "custom",
        path: [field],
        message: `contains "${leaked[0]}" — other bug_report parameters were written inside this value. Call bug_report again with each value in its own field (suspectedTool, severity, blockedTask are separate arguments) and plain text in ${field}.`,
      });
    }
  });

export type BugReportToolInput = z.infer<typeof bugReportToolInput>;

/**
 * What the AI may tell the operator about where a report went. Kept next to
 * the tool so the description's "never claim more than this" rule and the
 * sentence it points at cannot drift apart.
 */
export function describeBugForwarding(state: BugForwardingState): string {
  switch (state) {
    case "local_only":
      return (
        "It is stored on this site only (Settings → Detected bugs); the Caelo team is NOT notified automatically. " +
        "If you mention it to the operator, say it was recorded on this site — never that Caelo or its team was told."
      );
    case "queued":
      return "It is queued and will be sent to the Caelo team automatically (the Owner opted in).";
    case "sent":
      return "It was sent to the Caelo team.";
    case "failed":
      return (
        "Sending it to the Caelo team failed; it is stored on this site (Settings → Detected bugs). " +
        "Do not tell the operator the Caelo team was told."
      );
  }
}

export const bugReportTool: ToolDefinitionWithHandler<BugReportToolInput> = {
  name: "bug_report",
  description:
    "File a bug report against Caelo ITSELF when a tool or surface behaves contrary to its documented contract — e.g. a tool result contradicts persisted state, a screenshot/render ignores a parameter, an error fires on input the description says is valid. " +
    "This is for defects in the SYSTEM, not for your own mistakes (wrong arguments, misread state) and not for content/design issues on the site being built. " +
    "Report ONCE per distinct defect (do not re-file the same bug in one session), then CONTINUE the task via a workaround when one exists. Only when the bug genuinely blocks the task: file with blockedTask=true, tell the operator in one sentence what is blocked, and stop that line of work instead of retrying into the same wall. " +
    "`whatHappened` = what you observed (include the exact tool + arguments); `expected` = what the tool's contract promised; `evidence` = the result excerpt that proves it. " +
    "The result says where the report went (stored on this site only, or sent to the Caelo team) — tell the operator exactly that and never claim the Caelo team was notified unless the result says it was sent.",
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
    const { id, forwardingState } = r.value as { id: string; forwardingState: BugForwardingState };
    return {
      ok: true,
      content:
        `Bug report ${id} recorded (${input.severity}${input.blockedTask ? ", task blocked" : ""}). ` +
        `${describeBugForwarding(forwardingState)} ` +
        (input.blockedTask
          ? "Tell the operator in one sentence what is blocked, then stop this line of work."
          : "Continue the task with your workaround — do not re-file this defect."),
    };
  },
};
