// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — a page's terms (entries of vocabulary lists). On a branch
 * they live in the page snapshot (`PageState.terms`); the live set is the
 * `page_terms` table, written by live page writes, the Stage merge and
 * reverts. There is no FK to the entry (entries live inside
 * `lists.items`), so a term to a removed entry is a reference-integrity
 * finding, not a constraint violation (docs/lists.md §11).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { TERM_REF_RE } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** A parsed `caelo:term/<listId>/<itemId>`. */
export interface TermRef {
  readonly listId: string;
  readonly itemId: string;
}

/** Parse a term reference; null when the string is not one. */
export function parseTermRef(ref: string): TermRef | null {
  const m = TERM_REF_RE.exec(ref);
  return m?.[1] && m[2] ? { listId: m[1], itemId: m[2] } : null;
}

/** Format a term reference. */
export function formatTermRef(t: TermRef): string {
  return `caelo:term/${t.listId}/${t.itemId}`;
}

/**
 * Replace the live terms of `pageId` with `terms` (term references,
 * already validated). Order is kept through `created_at`.
 */
export async function replacePageTerms(
  tx: TransactionRunner,
  pageId: string,
  terms: readonly string[],
): Promise<void> {
  await tx.execute(sql`DELETE FROM page_terms WHERE page_id = ${pageId}::uuid`);
  let i = 0;
  for (const ref of terms) {
    const t = parseTermRef(ref);
    if (!t) {
      throw new Error(
        `replacePageTerms: "${ref}" is not a term reference (caelo:term/<listId>/<itemId>)`,
      );
    }
    await tx.execute(sql`
      INSERT INTO page_terms (page_id, list_id, item_id, created_at)
      VALUES (${pageId}::uuid, ${t.listId}::uuid, ${t.itemId}::uuid,
              clock_timestamp() + make_interval(secs => ${i}::double precision / 1000000))
      ON CONFLICT DO NOTHING
    `);
    i += 1;
  }
}
