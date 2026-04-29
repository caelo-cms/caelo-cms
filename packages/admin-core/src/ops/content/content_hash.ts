// SPDX-License-Identifier: MPL-2.0

/**
 * P9 — content_hash recompute helper.
 *
 * Called from page-write paths (set_page_modules, update_page) so the
 * source page's `content_hash` + `content_changed_at` reflect every
 * mutation. Translation variants compare their `translated_from_hash`
 * to the source's `content_hash` to derive `translation_status`
 * (fresh / stale).
 *
 * The hash domain is template_id + ordered (block_name, module_id,
 * module html/css/js). Page metadata (slug, locale, name, title,
 * SEO sidecar) is intentionally NOT in the hash — those don't make
 * a translation stale.
 */

import type { TransactionRunner } from "@caelo/query-api";
import { computeContentHash } from "@caelo/shared";
import { sql } from "drizzle-orm";

interface PageRow {
  template_id: string;
  locale: string;
}

interface ModuleSlot {
  block_name: string;
  position: number;
  html: string;
  css: string | null;
  js: string | null;
}

export async function recomputePageContentHash(
  tx: TransactionRunner,
  pageId: string,
): Promise<{ hash: string; changedAt: string } | null> {
  const pageRows = (await tx.execute(sql`
    SELECT template_id::text AS template_id, locale
    FROM pages WHERE id = ${pageId}::uuid LIMIT 1
  `)) as unknown as PageRow[];
  const page = pageRows[0];
  if (!page) return null;

  const moduleRows = (await tx.execute(sql`
    SELECT pm.block_name, pm.position,
           m.html AS html, m.css AS css, m.js AS js
    FROM page_modules pm
    JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
    WHERE pm.page_id = ${pageId}::uuid
    ORDER BY pm.block_name ASC, pm.position ASC
  `)) as unknown as ModuleSlot[];

  const hashInput = {
    templateId: page.template_id,
    blocks: moduleRows.map((m) => ({
      blockName: m.block_name,
      position: m.position,
      html: m.html,
      css: m.css ?? "",
      js: m.js ?? "",
    })),
  };
  const hash = await computeContentHash(hashInput);
  await tx.execute(sql`
    UPDATE pages
    SET content_hash = ${hash},
        content_changed_at = now()
    WHERE id = ${pageId}::uuid
  `);

  // Recompute translation_status for variants that point at this page.
  // A variant is fresh when its translated_from_hash matches the
  // source's content_hash; otherwise stale.
  await tx.execute(sql`
    UPDATE pages
    SET translation_status = CASE
      WHEN translated_from_hash = ${hash} THEN 'fresh'
      ELSE 'stale'
    END
    WHERE slug = (SELECT slug FROM pages WHERE id = ${pageId}::uuid)
      AND id <> ${pageId}::uuid
      AND translated_from_hash IS NOT NULL
      AND deleted_at IS NULL
  `);

  return {
    hash,
    changedAt: new Date().toISOString(),
  };
}
