// SPDX-License-Identifier: MPL-2.0

/**
 * Loads every text a page can be built from and scans it for font-weight
 * usage (`scanSiteFontUsage`), the input to the default axis policy of
 * pinned faces.
 *
 * Why every row, on every branch: the scan must be a SUPERSET of what any
 * rendered page can contain, and preview and build must agree. Reading
 * modules, templates, layouts and content values regardless of chat
 * branch means a chat preview already instances faces for the weights its
 * branch adds, and the deployed site never ships a range narrower than
 * something an editor previewed. Unpublished rows can only widen the
 * range (more bytes), never cut a weight a live page needs.
 *
 * What is read: module html/css/js plus field defaults (rich-text
 * defaults can carry inline styles), template and layout html/css,
 * shared and per-placement content values (rich text), and Tier-2 plugin
 * source (its components render into pages and inherit the family).
 * Tier-1 plugin source ships with Caelo and is not in the database; the
 * guard test `font-usage-sources.test.ts` asserts it sets no font weight,
 * so a future Tier-1 plugin that does fails CI instead of being missed.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type FontUsageSource,
  type SiteFontUsage,
  scanSiteFontUsage,
  type ThemeDocument,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/**
 * Scan the theme plus every stored site text for font usage.
 *
 * @param extraSources texts rendered alongside stored ones that are not
 *   rows yet (a Genesis design draft being previewed)
 */
export async function loadSiteFontUsage(
  tx: TransactionRunner,
  tokens: ThemeDocument,
  extraSources: readonly FontUsageSource[] = [],
): Promise<SiteFontUsage> {
  const rows = (await tx.execute(sql`
    SELECT 'module:' || slug AS label,
           html || E'\n' || css || E'\n' || js || E'\n' || fields::text AS text
      FROM modules WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'template:' || slug, html || E'\n' || css
      FROM templates WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'layout:' || slug, html || E'\n' || css
      FROM layouts WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'content:' || COALESCE(slug, id::text), values::text
      FROM content_instances WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'placement:' || id::text, content_values::text
      FROM page_module_content
    UNION ALL
    SELECT 'plugin:' || slug, source_code
      FROM plugins WHERE source_code IS NOT NULL
  `)) as unknown as { label: string; text: string }[];
  return scanSiteFontUsage({ tokens, sources: [...rows, ...extraSources] });
}
