// SPDX-License-Identifier: MPL-2.0

/**
 * Shared error-string helper for AI tools. Turns a Query API
 * `QueryError` into human-readable text the AI can act on: every Zod
 * issue of a ValidationFailed (shared path format, #1277), the .message
 * of a HandlerError, the .detail of an RLSDenied. A Postgres failure is
 * described by the caller's value, never by constraint / table / SQL.
 */

import {
  describePgFailure,
  errorDetailsOf,
  extractPgFields,
  failureKindOf,
  formatErrorDetails,
  type PgFailureFields,
} from "@caelo-cms/query-api";
import type { ToolResult } from "./dispatch.js";

export function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as {
    kind?: string;
    message?: string;
    issues?: unknown[];
    detail?: string;
    pgDetail?: PgFailureFields;
    nextAction?: {
      tool?: string;
      args?: Record<string, unknown>;
      reason?: string;
      autoExecute?: boolean;
    };
  };
  const primary = withListToolHint(describePrimary(e, error));
  // v0.6.0 W3 — append the structured recovery hint after the primary
  // message so the AI sees both "what went wrong" and "what to try
  // next" in one tool-result string. The chat-runner consumes
  // `nextAction.autoExecute` separately to drive automatic recovery;
  // this rendering is what surfaces to the model regardless.
  if (e.nextAction && typeof e.nextAction.tool === "string") {
    const na = e.nextAction;
    const argsPart =
      na.args && Object.keys(na.args).length > 0 ? ` with args ${JSON.stringify(na.args)}` : "";
    const reasonPart =
      typeof na.reason === "string" && na.reason.length > 0 ? ` — ${na.reason}` : "";
    return `${primary} | next: call \`${na.tool}\`${argsPart}${reasonPart}`;
  }
  return primary;
}

function describePrimary(
  e: {
    kind?: string;
    message?: string;
    issues?: unknown[];
    detail?: string;
    pgDetail?: PgFailureFields;
  },
  rawError: unknown,
): string {
  if (e.kind === "ValidationFailed" && Array.isArray(e.issues)) {
    return `validation: ${formatErrorDetails(errorDetailsOf(e))}`;
  }
  // #1277 — Postgres internals (constraint, table, SQL text) never reach
  // the AI; the failure is described in terms of the caller's value.
  if (e.pgDetail?.code && /^[0-9A-Z]{5}$/.test(e.pgDetail.code)) {
    return describePgFailure(e.pgDetail).message;
  }
  const message = typeof e.message === "string" ? e.message : null;
  if (message?.startsWith("Failed query")) {
    const fields = extractPgFields(rawError);
    return fields?.code
      ? describePgFailure(fields).message
      : "a database error the call cannot fix — a defect in Caelo, reported automatically";
  }
  if (message) return message;
  if (typeof e.detail === "string") return e.detail;
  return e.kind ?? "unknown";
}

/**
 * Issue #1277 — which tool lists the valid ids, per entity noun of a
 * "… not found" message. First match wins, so the longer nouns
 * (`content_instance`, `import run`, `page type`) come before the
 * shorter ones they contain.
 */
const LIST_TOOL_BY_NOUN: readonly (readonly [RegExp, string])[] = [
  [/content[_ ]instance/i, "list_content_instances"],
  [/import run/i, "list_import_runs"],
  [/import page/i, "list_import_pages"],
  [/page type/i, "list_page_types"],
  [/list type/i, "list_list_types"],
  [/\b(media|asset|crop|image)\b/i, "find_media"],
  [/\btheme\b/i, "list_themes"],
  [/\btemplate\b/i, "list_templates"],
  [/\blayout\b/i, "list_layouts"],
  [/\bmodule\b/i, "list_modules"],
  [/\bpage\b/i, "list_pages"],
  [/\buser\b/i, "list_users"],
  [/\brole\b/i, "list_roles"],
  [/\bsnapshot\b/i, "list_snapshots"],
  [/\bproposal\b/i, "list_pending_proposals"],
  [/\bdomain\b/i, "list_domains"],
  [/\bredirect\b/i, "find_redirects"],
  [/\bplugin\b/i, "list_plugins"],
  [/\blist\b/i, "list_lists"],
];

/**
 * Issue #1277 — every "… not found" names the tool that lists the valid
 * ids. Ops write the bare fact; a message that already names a list /
 * find / get tool is left alone.
 */
function withListToolHint(message: string): string {
  if (!/not found/i.test(message) || /\b(list|find|get)_[a-z_]+/.test(message)) return message;
  const subject = message.slice(0, message.search(/not found/i));
  const hit = LIST_TOOL_BY_NOUN.find(([re]) => re.test(subject));
  return hit ? `${message.replace(/[.\s]+$/, "")} — \`${hit[1]}\` shows the valid ones.` : message;
}

/**
 * Issue #1277 — the failed {@link ToolResult} for a Query API error: the
 * caller's text plus the structure #1275 keys on (`failureKind`, the
 * absolute-path `errors[]`) and the #1091 refusal flag. `content` is the
 * text the tool already wrote, usually built around {@link describeError}.
 *
 * @param error - the op's `QueryError`.
 * @param content - the tool's rendering of it.
 * @param rootRename - when the tool names the op's top-level array
 *   differently (the op's `instances` are the tool's `items`), the op
 *   name and the tool name, so every path addresses the TOOL's arguments.
 */
export function toolError(
  error: unknown,
  content: string,
  rootRename?: { readonly from: string; readonly to: string },
): ToolResult & { readonly ok: false } {
  const errors = errorDetailsOf(error).map((d) =>
    rootRename && d.path[0] === rootRename.from
      ? { ...d, path: [rootRename.to, ...d.path.slice(1)] }
      : d,
  );
  return {
    ok: false,
    content,
    failureKind: failureKindOf(error),
    ...(errors.length > 0 ? { errors } : {}),
    ...forwardRefusal(error),
  };
}

/**
 * v0.6.0 W3 — pull the `nextAction` block off a `QueryError.HandlerError`
 * so tool handlers can forward it onto their `ToolResult.nextAction`.
 * Returns undefined when the error isn't a HandlerError, doesn't carry a
 * nextAction, or carries a malformed one (the runtime contract requires
 * `tool` + `reason` strings at minimum).
 */
export function forwardNextAction(error: unknown):
  | {
      tool: string;
      args?: Record<string, unknown>;
      reason: string;
      autoExecute?: boolean;
      retryWithArgs?: { argName: string; fromValuePath: string };
    }
  | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as {
    kind?: string;
    nextAction?: {
      tool?: unknown;
      args?: unknown;
      reason?: unknown;
      autoExecute?: unknown;
      retryWithArgs?: unknown;
    };
  };
  if (e.kind !== "HandlerError") return undefined;
  const na = e.nextAction;
  if (!na || typeof na.tool !== "string" || typeof na.reason !== "string") return undefined;
  const out: {
    tool: string;
    args?: Record<string, unknown>;
    reason: string;
    autoExecute?: boolean;
    retryWithArgs?: { argName: string; fromValuePath: string };
  } = { tool: na.tool, reason: na.reason };
  if (na.args && typeof na.args === "object") out.args = na.args as Record<string, unknown>;
  if (typeof na.autoExecute === "boolean") out.autoExecute = na.autoExecute;
  if (
    na.retryWithArgs &&
    typeof na.retryWithArgs === "object" &&
    typeof (na.retryWithArgs as { argName?: unknown }).argName === "string" &&
    typeof (na.retryWithArgs as { fromValuePath?: unknown }).fromValuePath === "string"
  ) {
    const r = na.retryWithArgs as { argName: string; fromValuePath: string };
    out.retryWithArgs = { argName: r.argName, fromValuePath: r.fromValuePath };
  }
  return out;
}

/**
 * #1091 — `{ refusal: true }` when `error` is an operation's deliberate
 * guard refusal (`HandlerError.refusal`), else `{}`. Spread into the
 * failed `ToolResult` so the chat's automatic bug capture can tell "the
 * tool told the AI how to proceed" from a defect.
 */
export function forwardRefusal(error: unknown): { refusal?: true } {
  if (!error || typeof error !== "object") return {};
  const e = error as { kind?: unknown; refusal?: unknown };
  return e.kind === "HandlerError" && e.refusal === true ? { refusal: true } : {};
}
