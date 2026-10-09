// SPDX-License-Identifier: MPL-2.0

/**
 * Human labels for lockable entities — what the operator and the AI read in
 * takeover notes, the Open changes overview and draft overlap warnings
 * (issue #620), instead of raw ids.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import type { LockedEntityKind } from "./locks.js";

/** Human label of a locked entity (slug / title / name), falling back to the id. */
export async function lockedEntityLabel(
  tx: TransactionRunner,
  kind: LockedEntityKind,
  entityId: string,
): Promise<string> {
  const lookup: Partial<Record<LockedEntityKind, SQL>> = {
    module: sql`SELECT COALESCE(display_name, slug) AS label FROM modules WHERE id = ${entityId}::uuid`,
    template: sql`SELECT COALESCE(display_name, slug) AS label FROM templates WHERE id = ${entityId}::uuid`,
    page: sql`SELECT COALESCE(title, slug) AS label FROM pages WHERE id = ${entityId}::uuid`,
    pageLayout: sql`SELECT COALESCE(title, slug) AS label FROM pages WHERE id = ${entityId}::uuid`,
    layout: sql`SELECT display_name AS label FROM layouts WHERE id = ${entityId}::uuid`,
    structuredSet: sql`SELECT display_name AS label FROM structured_sets WHERE id = ${entityId}::uuid`,
    theme: sql`SELECT display_name AS label FROM themes WHERE id = ${entityId}::uuid`,
    contentInstance: sql`
      SELECT COALESCE(ci.display_name, ci.slug, m.slug) AS label
      FROM content_instances ci LEFT JOIN modules m ON m.id = ci.module_id
      WHERE ci.id = ${entityId}::uuid`,
    redirect: sql`SELECT from_path AS label FROM redirects WHERE id = ${entityId}::uuid`,
  };
  const query = lookup[kind];
  if (!query) return `${kind} ${entityId}`;
  const rows = (await tx.execute(query)) as unknown as { label: string | null }[];
  return rows[0]?.label ?? `${kind} ${entityId}`;
}
