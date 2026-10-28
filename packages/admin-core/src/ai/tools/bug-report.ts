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
 *
 * #1192 — the AI also filed feature ideas and docs gaps here, and they
 * reached the public tracker as defects, using defect issue slots. `kind`
 * lets the AI say which one it files, with no question to the operator
 * (CLAUDE.md §1A): `defect` when something misbehaved, `suggestion` when
 * nothing did but Caelo lacked what the task needed. The description
 * decides it with examples taken from the real reports of 2026-10-26.
 */

import { execute } from "@caelo-cms/query-api";
import { bugReportKind, bugReportSeverity } from "@caelo-cms/shared";
import { z } from "zod";
import type { BugForwardingState } from "../../ops/ai/bug-reports.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const BUG_REPORT_FIELDS = [
  "kind",
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

/**
 * #1010 — the shortest report text that can carry a concrete observation.
 * A real-AI run filed `{title: "placeholder", whatHappened: "n/a",
 * expected: "n/a"}`: the model meant to call a deferred tool (list_layouts)
 * it could not emit yet, and what came out was the cheapest always-loaded
 * call with filler values (the same shape as load-skill.ts's
 * bootstrap_site_scaffold note). The floor and the placeholder refusal turn
 * that into an error that names both ways forward.
 */
const MIN_REPORT_TEXT = 10;

/**
 * Values that say "nothing here" — never a description of a defect. Compared
 * after trimming case, quotes, brackets and punctuation, so `"N/A."` and
 * `[placeholder]` match; a value of punctuation only (`-`, `...`) is empty
 * after that and matches too.
 */
const PLACEHOLDER_VALUES = new Set([
  "placeholder",
  "n/a",
  "na",
  "n.a",
  "tbd",
  "tba",
  "todo",
  "test",
  "testing",
  "none",
  "null",
  "nil",
  "undefined",
  "unknown",
  "empty",
  "nothing",
  "xxx",
  "foo",
  "asdf",
  "lorem ipsum",
]);

const EDGE_PUNCTUATION_RE = /^[\s"'`<>[\](){}*_.,:;!?-]+|[\s"'`<>[\](){}*_.,:;!?-]+$/g;

/** True when `value` is a filler token (or only punctuation), not report content. */
export function isPlaceholderValue(value: string): boolean {
  const normalized = value.toLowerCase().replace(EDGE_PUNCTUATION_RE, "");
  return normalized === "" || PLACEHOLDER_VALUES.has(normalized);
}

const REQUIRED_TEXT_FIELDS = ["title", "whatHappened", "expected"] as const;
const OPTIONAL_TEXT_FIELDS = ["suspectedTool", "evidence"] as const;

const VALID_REPORT_HINT =
  "A report needs a concrete observation. Defect: title = the defect in a few words, whatHappened = the exact tool + arguments you called and what it returned, expected = what that tool's description promised. " +
  "Suggestion: title = the missing capability in a few words, whatHappened = what the task needed and what Caelo lacks for it, expected = what would have helped. " +
  "If you meant to call a different tool that is not in your tool list yet, do not file a report — search for that tool and call it.";

/** A required report text: at least MIN_REPORT_TEXT characters, refused with the hint. */
function reportText(max: number) {
  return z
    .string()
    .max(max)
    .min(MIN_REPORT_TEXT, {
      error: `too short — at least ${MIN_REPORT_TEXT} characters. ${VALID_REPORT_HINT}`,
    });
}

export const bugReportToolInput = z
  .object({
    /** Required: the AI decides on every report (see the description). */
    kind: bugReportKind,
    title: reportText(200),
    whatHappened: reportText(4000),
    expected: reportText(4000),
    suspectedTool: z.string().max(200).optional(),
    evidence: z.string().max(8000).optional(),
    /** Defects only; a defect without one is 'degraded' (the op's default). */
    severity: bugReportSeverity.optional(),
    blockedTask: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, issues) => {
    if (input.kind === "suggestion" && input.severity !== undefined) {
      issues.addIssue({
        code: "custom",
        path: ["severity"],
        message:
          'severity grades defects only. Leave it out for kind="suggestion"; if something actually misbehaved, file kind="defect" with the severity instead.',
      });
    }
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (!isPlaceholderValue(input[field])) continue;
      issues.addIssue({
        code: "custom",
        path: [field],
        message: `"${input[field].trim()}" is a placeholder, not a description. ${VALID_REPORT_HINT}`,
      });
    }
    for (const field of OPTIONAL_TEXT_FIELDS) {
      const value = input[field];
      if (typeof value !== "string" || !isPlaceholderValue(value)) continue;
      issues.addIssue({
        code: "custom",
        path: [field],
        message: `"${value.trim()}" is a placeholder — leave ${field} out when you have nothing for it, or pass the real value.`,
      });
    }
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
        'Do not tell the operator the Caelo team was told. The Owner can send it again with one click on Settings → Detected bugs ("Send unsent reports"); you cannot re-send it yourself.'
      );
  }
}

export const bugReportTool: ToolDefinitionWithHandler<BugReportToolInput> = {
  name: "bug_report",
  description:
    "Report something about Caelo ITSELF to the Caelo team. Choose `kind` by one question: did something MISBEHAVE?\n" +
    '- kind="defect" — yes: a tool/surface contradicted its documented contract (result contradicts persisted state, render ignores a parameter, error on input the description calls valid). E.g. "screenshot_page ignores selector" (returned the full page, not the crop it promises). Set `severity`.\n' +
    '- kind="suggestion" — no: everything did what its description says, but Caelo LACKS what the task needed — a missing capability or option, a feature idea, a docs gap. E.g. "add_tracking_tag has no page/locale filter" (the tag loads site-wide; you needed it on German product pages only), "no consent-rate overview" (export_consent_log gives only raw rows), "consent log fields undocumented" (no description says what record_consent stores or for how long). A tool that works as described but should do more is a suggestion, not a defect. No `severity` for a suggestion.\n' +
    "DO NOT USE FOR: your own mistakes (wrong args, misread state); the site's content/design; a tool missing from YOUR list — search for it first; only when the search shows Caelo has no such capability is it a suggestion.\n" +
    "CORE RULES:\n" +
    "- Only after a concrete observation (a failure, or a need you could not meet). ONCE per distinct defect or suggestion per session, then CONTINUE via a workaround if one exists.\n" +
    "- Truly blocked: `blockedTask=true`, tell the operator in one sentence what is blocked, stop that line of work (no retrying into the same wall).\n" +
    "- The result says where it went (this site only, or sent to the Caelo team) — tell the operator exactly that; never claim the team was notified unless it says sent.",
  schema: bugReportToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "title", "whatHappened", "expected"],
    properties: {
      kind: {
        type: "string",
        enum: ["defect", "suggestion"],
        description:
          "defect = something misbehaved (contradicts its description) | suggestion = nothing misbehaved, Caelo lacks a capability, option or docs the task needed.",
      },
      title: {
        type: "string",
        minLength: MIN_REPORT_TEXT,
        maxLength: 200,
        description:
          'A few words. Defect: "screenshot_page ignores selector". Suggestion: "add_tracking_tag has no page/locale filter".',
      },
      whatHappened: {
        type: "string",
        minLength: MIN_REPORT_TEXT,
        maxLength: 4000,
        description:
          "Defect: observed behaviour incl. the exact tool + arguments. Suggestion: what the task needed and what Caelo lacks for it (and your workaround, if any).",
      },
      expected: {
        type: "string",
        minLength: MIN_REPORT_TEXT,
        maxLength: 4000,
        description:
          "Defect: what the tool description / system contract promised. Suggestion: the capability, option or docs that would have helped.",
      },
      suspectedTool: { type: "string", maxLength: 200 },
      evidence: {
        type: "string",
        maxLength: 8000,
        description: "Result/render excerpt proving the mismatch (defect) or the gap (suggestion).",
      },
      severity: {
        type: "string",
        enum: ["blocking", "degraded", "cosmetic"],
        description:
          "Defects only — leave out for a suggestion. blocking = no workaround | degraded = worked around | cosmetic = noise only.",
      },
      blockedTask: {
        type: "boolean",
        description: "true ONLY if you abandoned the current task because of this.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_bug_reports.create", {
      chatSessionId: toolCtx.chatSessionId ?? null,
      kind: input.kind,
      title: input.title,
      whatHappened: input.whatHappened,
      expected: input.expected,
      suspectedTool: input.suspectedTool ?? null,
      evidence: input.evidence ?? null,
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      blockedTask: input.blockedTask,
    });
    if (!r.ok) {
      return { ok: false, content: `ai_bug_reports.create failed: ${describeError(r.error)}` };
    }
    const { id, forwardingState } = r.value as { id: string; forwardingState: BugForwardingState };
    const blocked = input.blockedTask ? ", task blocked" : "";
    const recorded =
      input.kind === "suggestion"
        ? `Suggestion ${id} recorded${input.blockedTask ? " (task blocked)" : ""}.`
        : `Bug report ${id} recorded (${input.severity ?? "degraded"}${blocked}).`;
    return {
      ok: true,
      content:
        `${recorded} ${describeBugForwarding(forwardingState)} ` +
        (input.blockedTask
          ? "Tell the operator in one sentence what is blocked, then stop this line of work."
          : `Continue the task with your workaround — do not re-file this ${input.kind}.`),
    };
  },
};
