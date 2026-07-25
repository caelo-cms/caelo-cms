// SPDX-License-Identifier: MPL-2.0

/**
 * Media slug resolution — turn a human label into a UNIQUE
 * `media_assets.slug` used as the public asset URL (`/_assets/<slug>.<ext>`)
 * and the admin preview URL (`/_caelo/media/<slug>`); the UUID id stays
 * internal. The pure slugify half lives in `@caelo-cms/shared`
 * (`slugifyMediaName`); uniqueness needs the DB, so it lives here.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { slugifyMediaName } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/**
 * Resolve a unique media slug from a desired label. Slugifies it, then
 * appends `-2`/`-3`… until it doesn't collide with a LIVE media_assets.slug.
 * One query collects every colliding slug; the gap is picked in memory.
 * Call inside the upload transaction so the check + insert are atomic.
 */
export async function resolveUniqueMediaSlug(
  tx: TransactionRunner,
  desiredLabel: string,
): Promise<string> {
  const base = slugifyMediaName(desiredLabel);
  const rows = (await tx.execute(sql`
    SELECT slug FROM media_assets
    WHERE deleted_at IS NULL AND (slug = ${base} OR slug LIKE ${`${base}-%`})
  `)) as unknown as Array<{ slug: string }>;
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
