// SPDX-License-Identifier: MPL-2.0

/**
 * Query-source knobs in the list editor (epic #1107, `docs/lists.md` §6).
 * A query node's type fixes `defaults` and names the `editable` knobs; an
 * entry stores only overrides of those knobs (`ListItem.query`). The
 * editor shows exactly the editable knobs and computes the query that
 * will run, so the operator never sees — or sets — a knob the type keeps
 * fixed.
 */

import type { PageQuery, QueryKnob, SourceDef } from "@caelo-cms/shared";

/** Operator-facing names of the knobs. */
export const KNOB_LABELS: Readonly<Record<QueryKnob, string>> = {
  page_type: "Page type",
  terms: "Terms",
  terms_mode: "Match",
  parent: "Below page",
  exclude_current: "Leave out the page being shown",
  order: "Order",
  limit: "How many",
};

/** Fixed orders (property orders are `prop_desc:<name>` / `prop_asc:<name>`). */
export const ORDER_LABELS: Readonly<Record<string, string>> = {
  published_desc: "Newest first",
  published_asc: "Oldest first",
  title_asc: "Title A–Z",
};

type QuerySource = Extract<SourceDef, { kind: "query" }>;

/** The knobs an entry of this source may set. */
export function editableKnobs(source: SourceDef | undefined): readonly QueryKnob[] {
  return source?.kind === "query" ? source.editable : [];
}

/** The query that runs for an entry: the type's defaults, then the entry's overrides. */
export function effectiveQuery(
  source: QuerySource,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Partial<PageQuery> {
  const out: Record<string, unknown> = { ...source.defaults };
  for (const k of source.editable) {
    if (overrides && overrides[k] !== undefined) out[k] = overrides[k];
  }
  return out as Partial<PageQuery>;
}

/**
 * Overrides with `knob` set to `value` — or removed when `value` is
 * undefined / equals the default, so an entry stores only what differs.
 * A knob that is not editable is never written.
 */
export function setKnob(
  source: QuerySource,
  overrides: Readonly<Record<string, unknown>> | undefined,
  knob: QueryKnob,
  value: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(overrides ?? {}) };
  const isDefault = JSON.stringify(source.defaults[knob]) === JSON.stringify(value);
  if (!source.editable.includes(knob) || value === undefined || value === "" || isDefault) {
    delete next[knob];
  } else {
    next[knob] = value;
  }
  return next;
}
