// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1275 — which failed tool calls are kept for `retry_tool_call`,
 * and what the AI is told about a kept one.
 *
 * A failed write call used to cost a resend of the WHOLE call (every
 * module's HTML again) to fix one value. A kept call's normalized
 * arguments ride its `chat_tool_results` row, and the AI fixes it with a
 * patch. One rule for every write tool — no size threshold, no per-tool
 * opt-in — decided from the result's structure (#1277), never by reading
 * its text:
 *
 *   kept    a schema error (`InvalidArguments`), `ValidationFailed`, a
 *           version / stale-draft `Conflict`, a lock conflict (`Locked`,
 *           `SiblingLeaseConflict`), and a `HandlerError` that names the
 *           input it refused (`errors[]` non-empty — a validation error
 *           in #1277's shape);
 *   never   permission / actor-scope / RLS denials, budget refusals and
 *           any other failure that names no input path, `internal`
 *           defects, approval-gated tools (`approvalMode` / `gated`: the
 *           approval card holds the call), read and meta tools, calls with
 *           empty arguments (the deferred-tool case `schemaRecoveryBlock`
 *           answers), plugin tools (they bypass `ToolRegistry.dispatch`,
 *           so no result carries `call` — a known gap) and
 *           `retry_tool_call` itself (its failure keeps the ORIGINAL id
 *           retryable).
 */

import { isReadOrMetaTool } from "../chat-runner/write-tools.js";
import type { ToolRegistry, ToolResult } from "./dispatch.js";

/** The tool this file keeps calls for. */
export const RETRY_TOOL_NAME = "retry_tool_call";

/** Failure kinds a patch of the same call can fix. */
const KEPT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "InvalidArguments",
  "ValidationFailed",
  "Conflict",
  "Locked",
  "SiblingLeaseConflict",
]);

/**
 * The arguments to keep for a failed `result`, or null when the call is
 * not kept (see the file header).
 *
 * @param tools - the registry that dispatched the call (gate markers).
 */
export function keptCallArgs(
  result: ToolResult,
  tools: Pick<ToolRegistry, "get">,
): Record<string, unknown> | null {
  if (result.ok || !result.call) return null;
  const { name, args } = result.call;
  if (name === RETRY_TOOL_NAME || isReadOrMetaTool(name)) return null;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  if (Object.keys(args).length === 0) return null;
  const tool = tools.get(name);
  if (!tool || tool.gated || tool.approvalMode) return null;
  const kind = result.failureKind;
  if (kind === undefined) return null;
  const fixable =
    KEPT_FAILURE_KINDS.has(kind) || (kind === "HandlerError" && (result.errors?.length ?? 0) > 0);
  return fixable ? (args as Record<string, unknown>) : null;
}

/**
 * The line a kept failure ends with: how to fix it with a patch. A
 * version conflict first needs a fresh read.
 */
export function keptCallNotice(toolCallId: string, result: ToolResult): string {
  const first = result.errors?.[0]?.path;
  const example =
    first && first.length > 0
      ? `set:[{path:${JSON.stringify(first)}, value:…}]`
      : "set:[{path:[…], value:…}]";
  const lead =
    result.failureKind === "Conflict"
      ? "Read the current version first, then fix"
      : result.failureKind === "Locked" || result.failureKind === "SiblingLeaseConflict"
        ? "Once the lock is released, fix"
        : "Fix";
  return `${lead} with \`retry_tool_call({toolCallId:"${toolCallId}", ${example}})\` (patch only what the errors name; \`replace\` edits text inside one string) or resend.`;
}

/** `result` with the kept-call notice appended to its content. */
export function withKeptCallNotice<R extends ToolResult>(toolCallId: string, result: R): R {
  return { ...result, content: `${result.content}\n${keptCallNotice(toolCallId, result)}` };
}
