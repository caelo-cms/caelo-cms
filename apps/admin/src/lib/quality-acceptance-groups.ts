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
  /** Null for a site-wide page-check acceptance (a finding with no page). */
  readonly pageId: string | null;
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
  /**
   * Stable key: `check:<rule>`, `check-site:<rule>` (site-wide),
   * `finding:<audit>` or `score:<category>`.
   */
  readonly key: string;
  /** What was accepted, as the operator reads it. */
  readonly label: string;
  readonly kind: AcceptanceRow["kind"];
  /**
   * A site-wide acceptance covers findings that belong to no page, so it is
   * its own group: counting it as "1 page(s)" next to the per-page
   * acceptances of the same rule would misstate what was decided.
   */
  readonly siteWide: boolean;
  readonly rows: readonly AcceptanceRow[];
  /** The distinct reasons given (a bulk decision usually has one). */
  readonly reasons: readonly string[];
  /** The distinct accepted values ("up to 2 error(s)", "score 88"). */
  readonly values: readonly string[];
}

const CATEGORY_LABEL: Record<string, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

function keyOf(row: AcceptanceRow): { key: string; label: string; siteWide: boolean } {
  if (row.kind === "score") {
    const c = row.category ?? "";
    return {
      key: `score:${c}`,
      label: `${CATEGORY_LABEL[c] ?? c} score below 100`,
      siteWide: false,
    };
  }
  const id = row.auditId ?? "";
  if (row.kind === "finding") {
    return { key: `finding:${id}`, label: `Lighthouse ${id}`, siteWide: false };
  }
  return row.pageId === null
    ? { key: `check-site:${id}`, label: id, siteWide: true }
    : { key: `check:${id}`, label: id, siteWide: false };
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
    {
      key: string;
      label: string;
      kind: AcceptanceRow["kind"];
      siteWide: boolean;
      rows: AcceptanceRow[];
    }
  >();
  for (const row of rows) {
    if (row.revokedAt !== null) continue;
    const { key, label, siteWide } = keyOf(row);
    let g = groups.get(key);
    if (!g) {
      g = { key, label, kind: row.kind, siteWide, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      reasons: [...new Set(g.rows.map((r) => r.reason))],
      values: [...new Set(g.rows.map(acceptedValue))],
    }))
    .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}
