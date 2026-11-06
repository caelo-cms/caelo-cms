// SPDX-License-Identifier: MPL-2.0

/**
 * #1484 — which failed tool results become bug reports.
 *
 * A failed tool result is one of two things: the tool answering as designed
 * (the AI reads the answer and acts on it), or Caelo failing. Only the second
 * is a bug, so the capture decides from the result's STRUCTURE (`failureKind`,
 * `errors`, `refusal`, `nextAction`, `retryable`), never from its text. The
 * structure must say "expected"; a result that says nothing is a defect,
 * because a missed defect costs more than one noisy report:
 *
 *   expected  a guard refusal (`refusal`, set from `HandlerError.refusal` or by
 *             a tool-level gate), a call kept for `retry_tool_call`
 *             (`retryable`), a validation error, a version or lock conflict, a
 *             `HandlerError` that names the input it refused (`errors[]`), and
 *             any failure that names its next tool (`nextAction`);
 *   defect    `internal` (always, whatever else the result carries), every
 *             other kind (RLS denial, actor scope, unknown op or tool, a
 *             schema refusal the AI cannot patch) and a failure with no
 *             structure at all: a thrown handler, a provider failure, a plain
 *             `{ ok: false, content }`.
 *
 * An expected refusal can still mean something is wrong when the AI gets the
 * same answer again and again: either it is stuck, or the answer is. That one
 * signal is kept as a low-severity report (see {@link captureToolFailure}).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { ToolDispatchResult } from "./types.js";

/** Whether a failed tool result is the tool answering, or Caelo failing. */
export type ToolFailureClass = "expected" | "defect";

/** The result fields the classification reads. */
type ClassifiedResult = Pick<
  ToolDispatchResult,
  "refusal" | "retryable" | "failureKind" | "errors" | "nextAction"
>;

/** Failure kinds that are answers by their type alone (see the file header). */
const EXPECTED_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "ValidationFailed",
  "Conflict",
  "Locked",
  "SiblingLeaseConflict",
]);

/**
 * How many times one tool may give one chat the same refusal before that is
 * reported. High enough that an AI working through a large page does not
 * reach it: an answer repeated this often was not acted on.
 */
export const REPEATED_REFUSAL_REPORT_AT = 5;

/**
 * Classify a failed tool result. Reads structure only; a result with no
 * structure is a `defect` (see the file header).
 */
export function classifyToolFailure(result: ClassifiedResult): ToolFailureClass {
  if (result.failureKind === "internal") return "defect";
  if (result.refusal === true || result.retryable === true) return "expected";
  if (result.nextAction !== undefined) return "expected";
  const kind = result.failureKind;
  if (kind === undefined) return "defect";
  if (EXPECTED_FAILURE_KINDS.has(kind)) return "expected";
  return kind === "HandlerError" && (result.errors?.length ?? 0) > 0 ? "expected" : "defect";
}

/**
 * #1091 — whether a tool result is filed as an automatic bug report: a final
 * failure {@link classifyToolFailure} calls a defect, except from the bug
 * channel itself (a broken channel must not recurse into filing about itself).
 */
export function shouldAutoCaptureToolFailure(
  toolName: string,
  result: Pick<ToolDispatchResult, "ok"> & ClassifiedResult,
): boolean {
  return !result.ok && toolName !== "bug_report" && classifyToolFailure(result) === "defect";
}

/** The tool input as report evidence, under the op's 8000-char cap. */
function toolInputEvidence(toolName: string, args: unknown): string | undefined {
  try {
    return `Tool input (${toolName}):\n${JSON.stringify(args, null, 2)}`.slice(0, 7900);
  } catch {
    // A non-serializable argument must never break the capture.
    return undefined;
  }
}

/**
 * File a final tool failure into `ai_bug_reports` (source `auto`, deduped per
 * chat by the op), so a genuine defect is never lost because the AI did not
 * call `bug_report`. An expected refusal files nothing until the chat reached
 * {@link REPEATED_REFUSAL_REPORT_AT} of the same one; then one `cosmetic`
 * report says so, its text fixed so the op's dedup keeps it to one per chat.
 * Best-effort: a failure to record must never break the tool flow.
 *
 * @param args.reason - the failure text as the tool wrote it, before notices
 *   were appended: a kept call's notice carries its own call id, so the full
 *   text of two identical refusals differs.
 * @param args.reportCtx - the actor the report is filed as.
 * @param args.readCtx - the actor that may read the chat's cached results.
 */
export async function captureToolFailure(args: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly reportCtx: ExecutionContext;
  readonly readCtx: ExecutionContext;
  readonly chatSessionId: string;
  readonly toolName: string;
  readonly toolArguments: unknown;
  readonly result: ToolDispatchResult;
  readonly reason: string;
}): Promise<void> {
  const { registry, adapter, reportCtx, chatSessionId, toolName, result } = args;
  if (result.ok || toolName === "bug_report") return;
  const report = {
    chatSessionId,
    suspectedTool: toolName,
    evidence: toolInputEvidence(toolName, args.toolArguments),
    kind: "defect" as const,
    source: "auto" as const,
  };
  if (shouldAutoCaptureToolFailure(toolName, result)) {
    await execute(registry, adapter, reportCtx, "ai_bug_reports.create", {
      ...report,
      title: `Tool ${toolName} returned an error`.slice(0, 200),
      whatHappened: result.content.slice(0, 4000),
      expected: "The tool call should succeed, or fail with a recoverable non-error result.",
      severity: "degraded",
    }).catch(() => undefined);
    return;
  }
  const seen = await execute(registry, adapter, args.readCtx, "chat.count_tool_refusals", {
    chatSessionId,
    toolName,
    reason: args.reason,
  }).catch(() => null);
  if (!seen?.ok) return;
  const { count } = seen.value as { count: number };
  if (count < REPEATED_REFUSAL_REPORT_AT) return;
  await execute(registry, adapter, reportCtx, "ai_bug_reports.create", {
    ...report,
    title: `Tool ${toolName} gave one chat the same refusal ${REPEATED_REFUSAL_REPORT_AT} times`,
    whatHappened: args.reason.slice(0, 4000),
    expected: "A refusal names the next step, so the AI acts on it instead of repeating the call.",
    severity: "cosmetic",
  }).catch(() => undefined);
}
