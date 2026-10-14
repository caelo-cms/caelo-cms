// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the Owner reviews and revokes acceptances in bulk on
 * /settings/quality: live acceptances grouped by WHAT was accepted (one
 * rule / audit / category across pages), so a bulk decision ("accept
 * seo-check/description-missing on 312 pages") is reviewed and taken back
 * as one, not 312 rows. Pure; unit-tested.
 */

/** One acceptance row as `quality_acceptances.list` returns it. */
export interface AcceptanceRow {
  readonly id: string;
  readonly pagePath: string;
  readonly kind: "finding" | "score" | "check";
  readonly auditId: string | null;
  readonly category: string | null;
  readonly acceptedScore: number | null;
  readonly acceptedCount: number | null;
  readonly reason: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly revokedAt: string | null;
}

export interface AcceptanceGroup {
  /** Stable key: `check:<rule>`, `finding:<audit>` or `score:<category>`. */
  readonly key: string;
  /** What was accepted, as the operator reads it. */
  readonly label: string;
  readonly kind: AcceptanceRow["kind"];
  readonly rows: readonly AcceptanceRow[];
  /** The distinct reasons given (a bulk decision usually has one). */
  readonly reasons: readonly string[];
}

const CATEGORY_LABEL: Record<string, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

function keyOf(row: AcceptanceRow): { key: string; label: string } {
  if (row.kind === "score") {
    const c = row.category ?? "";
    return { key: `score:${c}`, label: `${CATEGORY_LABEL[c] ?? c} score below 100` };
  }
  const id = row.auditId ?? "";
  return row.kind === "check"
    ? { key: `check:${id}`, label: id }
    : { key: `finding:${id}`, label: `Lighthouse ${id}` };
}

/** What one row accepted on its page ("score 87", "up to 3 errors"). */
export function acceptedValue(row: AcceptanceRow): string {
  if (row.kind === "check") return `up to ${row.acceptedCount ?? 0} error(s)`;
  if (row.acceptedScore === null) return "as recorded";
  return `score ${row.acceptedScore}`;
}

/**
 * Live acceptances grouped by what they accepted; biggest group first.
 * Revoked rows are left out (they are history, listed separately).
 */
export function groupLiveAcceptances(rows: readonly AcceptanceRow[]): AcceptanceGroup[] {
  const groups = new Map<
    string,
    { key: string; label: string; kind: AcceptanceRow["kind"]; rows: AcceptanceRow[] }
  >();
  for (const row of rows) {
    if (row.revokedAt !== null) continue;
    const { key, label } = keyOf(row);
    let g = groups.get(key);
    if (!g) {
      g = { key, label, kind: row.kind, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, reasons: [...new Set(g.rows.map((r) => r.reason))] }))
    .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}
