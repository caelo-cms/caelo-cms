// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — one stored translation per key.
 *
 * Each translation table holds one row per key: a list value per language
 * and address, a term per language and entry, a page property per
 * language, page and field, a hidden entry per language and address, a
 * chrome variant per target and language. The writes keep it that way
 * through `ctx.adminQuery.upsert`, which serialises the writers of a key
 * within a line and whose rows of one key the Stage lands as one
 * (plugin-host private-upsert.ts, key-merge.ts).
 *
 * Rows can still share a key: written before that (a `list` then an
 * `insert` from two chats at once, or from a chat and the change
 * consumer's `missing` placeholder), or held by two lines until a Stage (a
 * chat's unstaged row beside a main-line placeholder, as the chat reads
 * them). Every read then takes the same row, by the rule below,
 * so the render, `intl_status`, the audit and the next write agree:
 *
 *   1. a row that holds a translation beats one that holds none (a
 *      placeholder never hides a translation);
 *   2. then by status: translated, needs_update, missing, orphaned
 *      (chrome: up_to_date before needs_update);
 *   3. then the later insert (the later write of the two);
 *   4. then the id, so two reads never differ.
 *
 * The other rows are folded away by the next write of the key: the upsert
 * keeps one row, under the key's lock, with what it writes. Nothing folds
 * them without a write: a fold has to choose which content stays, and a
 * choice made outside that lock could overwrite a translation a Stage
 * applied in between.
 */

const STATUS_RANK: Readonly<Record<string, number>> = {
  translated: 0,
  up_to_date: 0,
  needs_update: 1,
  missing: 2,
  orphaned: 3,
};

/** A stored row as the rule reads it; `created_at` comes with every read. */
interface RankedRow {
  readonly id: string;
  readonly created_at?: unknown;
}

function insertedAt(row: RankedRow): number {
  const at = typeof row.created_at === "string" ? Date.parse(row.created_at) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Of rows that share a key, the one every read takes (see the header).
 *
 * @param hasContent whether the row holds a translation.
 * @param status its status column (`status` / `translation_status`).
 */
export function preferredRow<R extends RankedRow>(
  rows: readonly R[],
  hasContent: (row: R) => boolean,
  status: (row: R) => string | null,
): R | undefined {
  // A status the table does not hold (visibility rows have none) ranks as missing.
  const rank = (r: R) => STATUS_RANK[status(r) ?? ""] ?? 2;
  return [...rows].sort((a, b) => {
    const content = Number(hasContent(b)) - Number(hasContent(a));
    if (content !== 0) return content;
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    const later = insertedAt(b) - insertedAt(a);
    if (later !== 0) return later;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * One row per key: the preferred row of each key, in the order the keys
 * first appear, and every other row (to fold away).
 */
export function onePerKey<R extends RankedRow>(
  rows: readonly R[],
  keyOf: (row: R) => string,
  hasContent: (row: R) => boolean,
  status: (row: R) => string | null,
): { rows: R[]; folded: R[] } {
  const byKey = new Map<string, R[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const group = byKey.get(k);
    if (group) group.push(r);
    else byKey.set(k, [r]);
  }
  const kept: R[] = [];
  const folded: R[] = [];
  for (const group of byKey.values()) {
    const winner = group.length === 1 ? group[0] : preferredRow(group, hasContent, status);
    if (!winner) continue;
    kept.push(winner);
    for (const r of group) if (r !== winner) folded.push(r);
  }
  return { rows: kept, folded };
}

/** A list value or page property row: a translation once it holds a value. */
function onePerValueKey<
  R extends RankedRow & { readonly value: string | null; readonly status: string },
>(rows: readonly R[], keyOf: (row: R) => string): { rows: R[]; folded: R[] } {
  return onePerKey(
    rows,
    keyOf,
    (r) => r.value !== null,
    (r) => r.status,
  );
}

/** `list_value_translations`: one row per language and address. */
export function onePerValueAddress<
  R extends RankedRow & {
    readonly locale_code: string;
    readonly address: string;
    readonly value: string | null;
    readonly status: string;
  },
>(rows: readonly R[]): { rows: R[]; folded: R[] } {
  return onePerValueKey(rows, (r) => `${r.locale_code}|${r.address}`);
}

/** `page_prop_translations`: one row per language, page and property. */
export function onePerPageProp<
  R extends RankedRow & {
    readonly locale_code: string;
    readonly page_id: string;
    readonly field: string;
    readonly value: string | null;
    readonly status: string;
  },
>(rows: readonly R[]): { rows: R[]; folded: R[] } {
  return onePerValueKey(rows, (r) => `${r.locale_code}|${r.page_id}|${r.field}`);
}

/** `term_translations`: one row per language and vocabulary entry. */
export function onePerTerm<
  R extends RankedRow & {
    readonly locale_code: string;
    readonly list_id: string;
    readonly item_id: string;
    readonly name: string | null;
    readonly slug: string | null;
    readonly status: string;
  },
>(rows: readonly R[]): { rows: R[]; folded: R[] } {
  return onePerKey(
    rows,
    (r) => `${r.locale_code}|${r.list_id}|${r.item_id}`,
    (r) => r.name !== null || r.slug !== null,
    (r) => r.status,
  );
}

/** `list_item_visibility`: one decision per language and entry. */
export function onePerHiddenEntry<
  R extends RankedRow & {
    readonly locale_code: string;
    readonly address: string;
    readonly hidden: boolean;
  },
>(rows: readonly R[]): { rows: R[]; folded: R[] } {
  return onePerKey(
    rows,
    (r) => `${r.locale_code}|${r.address}`,
    (r) => r.hidden,
    () => null,
  );
}

/** `chrome_variants`: one variant per chrome target and language. */
export function onePerChromeTarget<
  R extends RankedRow & {
    readonly target_key: string;
    readonly locale_code: string;
    readonly translation_status: string;
  },
>(rows: readonly R[]): { rows: R[]; folded: R[] } {
  return onePerKey(
    rows,
    (r) => `${r.target_key}|${r.locale_code}`,
    () => true,
    (r) => r.translation_status,
  );
}
