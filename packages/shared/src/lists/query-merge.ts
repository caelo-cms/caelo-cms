// SPDX-License-Identifier: MPL-2.0

/**
 * Merging a query source's defaults with the knobs an entry or placement
 * sets (`docs/lists.md` §6). A query that does not come out complete is
 * never guessed (CLAUDE.md §2): the render reports
 * `list-malformed:<field>[<path>.<knob>]`, the marker names the failing
 * knob, and `detail` says how to fix it — `preview_list_source` hands it to
 * the AI verbatim (#1281).
 */

import {
  type PageQuery,
  pageQuerySchema,
  QUERY_SOURCE_EXAMPLE,
  type QueryKnob,
  type SourceDef,
} from "./list-type.js";

/** Why a merged query failed: the marker the render reports + the fix. */
export interface QueryMergeFailure {
  readonly marker: string;
  readonly detail: string;
}

const ORDER_VALUES =
  '"published_desc", "published_asc", "title_asc", "prop_desc:<property>" or "prop_asc:<property>"';

/**
 * Merge `source.defaults` with `overrides` (an entry's / placement's knobs)
 * and parse the result as a complete page query.
 *
 * @param field The list field the source belongs to (marker prefix).
 * @param path Where the overrides live (`query`, `<itemId>.query`).
 */
export function mergeQuerySource(
  source: Extract<SourceDef, { kind: "query" }>,
  overrides: unknown,
  field: string,
  path: string,
): PageQuery | QueryMergeFailure {
  const fail = (at: string, detail: string): QueryMergeFailure => ({
    marker: `list-malformed:${field}[${at}]`,
    detail,
  });
  const merged: Record<string, unknown> = { ...source.defaults };
  const editable: readonly string[] = source.editable;
  if (overrides !== undefined && overrides !== null) {
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
      return fail(path, "the value of a query field is an object of query knobs, e.g. {limit:3}.");
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (!editable.includes(k as QueryKnob)) {
        return fail(
          `${path}.${k}`,
          `"${k}" cannot be set per entry or placement — the source's editable list is ${editable.length > 0 ? editable.join(", ") : "empty"}. Remove "${k}" from the value, or add it to source.editable.`,
        );
      }
      merged[k] = v;
    }
  }
  const parsed = pageQuerySchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const knob = issue?.path.map(String).join(".") ?? "";
  const at = knob === "" ? path : `${path}.${knob}`;
  if (knob === "order" && merged.order === undefined) {
    return fail(
      at,
      `the query has no "order" — add order (${ORDER_VALUES}) to source.defaults, e.g. ${QUERY_SOURCE_EXAMPLE}.`,
    );
  }
  if (knob === "limit" && merged.limit === undefined) {
    return fail(
      at,
      `the query has no "limit" — add limit (1–50) to source.defaults, e.g. ${QUERY_SOURCE_EXAMPLE}; for an overview of every matching page, give the list field paginate:{} instead.`,
    );
  }
  return fail(at, `query knob "${knob}" is invalid: ${issue?.message ?? "invalid value"}.`);
}
