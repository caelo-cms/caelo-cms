// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1277 — the one structured shape of an AI-facing input problem,
 * and the one formatter that renders it.
 *
 * Every validation failure the AI can fix names WHERE in its own call the
 * problem sits, as an absolute segment path in Zod's `issue.path` form
 * (`["modules", 3, "content", "values", "hero_title"]`). The text the AI
 * reads is produced from the same entries by {@link formatErrorDetails},
 * so text and structure cannot disagree, and a later patch (#1275,
 * `retry_tool_call`) can address exactly the value an error names.
 *
 * Four path notations existed before this file (`modules.3.fields.2.kind`,
 * `modules[3] ("Hero") at fields.2.kind`, `field "hero_title"`,
 * `items[0]:`); this is the only one now.
 */

import type { z } from "zod";
import type { QueryError } from "./errors.js";

/** One segment of an input path: an object key or an array index. */
export type ErrorPathSegment = string | number;

/**
 * One problem with the caller's input.
 *
 * @property path - absolute path into the caller's input (Zod `issue.path`
 *   form); `[]` names the input as a whole.
 * @property message - what is wrong, as a sentence fragment without the path.
 * @property allowed - the accepted values when the set is closed (block
 *   names, enum members, declared field names).
 * @property next - the step that fixes it, when it is not obvious from
 *   `message` (which tool lists the valid ids, which value to set).
 */
export interface ErrorDetail {
  readonly path: readonly ErrorPathSegment[];
  readonly message: string;
  readonly allowed?: readonly string[];
  readonly next?: string;
}

/**
 * What kind of failure a tool result reports. The `QueryError` kinds pass
 * through unchanged; three kinds exist only above the Query API:
 * `InvalidArguments` (the tool's own schema refused the call),
 * `UnknownTool`, and `internal` — a defect in Caelo's code that no change
 * to the call can fix (a thrown driver error, an INSERT that returned no
 * row). #1275 keeps a failed call for a patch only for fixable kinds;
 * `internal` is never kept and goes to the bug intake.
 */
export type FailureKind = QueryError["kind"] | "InvalidArguments" | "UnknownTool" | "internal";

/** At most this many problems are rendered as text; `errors[]` keeps all. */
export const MAX_RENDERED_ERRORS = 20;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/**
 * Render a segment path: `modules[3].content.values.hero_title`. Keys that
 * are not plain identifiers are quoted (`values["hero title"]`); the empty
 * path is `(root)`.
 */
export function formatErrorPath(path: readonly ErrorPathSegment[]): string {
  if (path.length === 0) return "(root)";
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (IDENTIFIER.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** One problem as one line: `` `path`: message (allowed: a | b). next ``. */
export function formatErrorDetail(detail: ErrorDetail): string {
  const message = detail.message.replace(/[.\s]+$/, "");
  const allowed =
    detail.allowed && detail.allowed.length > 0
      ? ` (allowed: ${detail.allowed.slice(0, 40).join(" | ")}${detail.allowed.length > 40 ? " | …" : ""})`
      : "";
  const next = detail.next ? ` ${detail.next.replace(/\s+$/, "")}` : "";
  return `\`${formatErrorPath(detail.path)}\`: ${message}${allowed}.${next}`;
}

/**
 * Every problem as text. One problem renders inline; several render one
 * per line under a count, at most {@link MAX_RENDERED_ERRORS} then `+N more`.
 */
export function formatErrorDetails(
  details: readonly ErrorDetail[],
  max = MAX_RENDERED_ERRORS,
): string {
  if (details.length === 0) return "";
  if (details.length === 1) return formatErrorDetail(details[0] as ErrorDetail);
  const shown = details.slice(0, max).map((d) => `- ${formatErrorDetail(d)}`);
  const more = details.length > max ? [`- +${details.length - max} more`] : [];
  return `${details.length} problems:\n${[...shown, ...more].join("\n")}`;
}

/**
 * Parse a rendered path back into segments: `items[2].values.label` →
 * `["items", 2, "values", "label"]`. For checkers that build their paths
 * as strings (the list validators); `(root)` and `""` are `[]`.
 */
export function parseErrorPath(path: string): ErrorPathSegment[] {
  if (path === "" || path === "(root)") return [];
  const out: ErrorPathSegment[] = [];
  const re = /\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\.?([^.[\]]+)/g;
  for (const m of path.matchAll(re)) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2] !== undefined) out.push(JSON.parse(`"${m[2]}"`) as string);
    else if (m[3] !== undefined) out.push(m[3]);
  }
  return out;
}

/** The same problems, addressed from one level up (`["items", 2]` + path). */
export function prefixErrorDetails(
  prefix: readonly ErrorPathSegment[],
  details: readonly ErrorDetail[],
): ErrorDetail[] {
  return details.map((d) => ({ ...d, path: [...prefix, ...d.path] }));
}

/**
 * Zod issues as error details. Symbol keys (never produced by our schemas)
 * are dropped from the path; enum-like issues carry their accepted values.
 */
export function zodIssuesToErrorDetails(
  issues: readonly z.ZodIssue[],
  prefix: readonly ErrorPathSegment[] = [],
): ErrorDetail[] {
  return issues.map((issue) => {
    const path = [
      ...prefix,
      ...issue.path.filter((s): s is string | number => typeof s !== "symbol"),
    ];
    const values =
      issue.code === "invalid_value" ? issue.values.map((v) => JSON.stringify(v)) : undefined;
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((k) => `\`${k}\``).join(", ");
      return { path, message: `unrecognized key(s) ${keys} — remove them` };
    }
    return values
      ? { path, message: issue.message, allowed: values }
      : { path, message: issue.message };
  });
}

/**
 * The `errors[]` of a failed result, whatever its kind: a `HandlerError`'s
 * own entries, a `ValidationFailed`'s Zod issues, or none.
 */
export function errorDetailsOf(error: unknown): ErrorDetail[] {
  if (!error || typeof error !== "object") return [];
  const e = error as { kind?: unknown; errors?: unknown; issues?: unknown };
  if (e.kind === "ValidationFailed" && Array.isArray(e.issues)) {
    return zodIssuesToErrorDetails(e.issues as z.ZodIssue[]);
  }
  if (Array.isArray(e.errors)) return e.errors as ErrorDetail[];
  return [];
}

/**
 * The {@link FailureKind} of a `QueryError`: its `kind`, except a
 * `HandlerError` marked `internal` (a defect, see `QueryError`).
 */
export function failureKindOf(error: unknown): FailureKind {
  if (!error || typeof error !== "object") return "internal";
  const e = error as { kind?: unknown; internal?: unknown };
  if (typeof e.kind !== "string") return "internal";
  if (e.kind === "HandlerError" && e.internal === true) return "internal";
  return e.kind as FailureKind;
}

/**
 * A `HandlerError` whose message IS the rendered `errors[]` (behind an
 * optional lead sentence and before an optional closing sentence), so the
 * text the AI reads and the structure a patch addresses always agree.
 */
export function handlerErrorFromDetails(
  operation: string,
  details: readonly ErrorDetail[],
  options: { lead?: string; trailer?: string; refusal?: boolean; internal?: boolean } = {},
): Extract<QueryError, { kind: "HandlerError" }> {
  const body = formatErrorDetails(details);
  const lead = options.lead ? `${options.lead.replace(/\s+$/, "")} ` : "";
  const trailer = options.trailer ? ` ${options.trailer}` : "";
  return {
    kind: "HandlerError",
    operation,
    message: `${lead}${body}${trailer}`,
    errors: details,
    ...(options.refusal ? { refusal: true as const } : {}),
    ...(options.internal ? { internal: true as const } : {}),
  };
}

/**
 * An internal defect: a state the caller's input cannot have caused and
 * cannot fix (an INSERT … RETURNING without a row). Marked `internal` so
 * it is never offered for a patch and reaches the bug intake.
 */
export function internalError(
  operation: string,
  message: string,
): Extract<QueryError, { kind: "HandlerError" }> {
  return {
    kind: "HandlerError",
    operation,
    message: `internal error in ${operation}: ${message}. This is a defect in Caelo, not in the call; it is reported automatically.`,
    internal: true,
  };
}
