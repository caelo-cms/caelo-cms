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
 *
 * Caching (issue #803): that read is a dump of the whole site, so the
 * result is cached in-process and reused while the scanned rows are
 * unchanged. Freshness is proven against the change journal (issue #1267,
 * docs/dev/state-and-changes.md), not guessed: the scan records the
 * journal mark it read at, and every write to the six scanned tables
 * leaves journal rows. A cached result is served only when the reader has
 * seen every transaction the cached scan saw and no journal row of those
 * tables is unseen by the cached mark — then both see the same rows, so a
 * fresh scan would return the same result. Preview and build call this
 * same function, so they share the cache and stay in parity.
 */

import { createHash } from "node:crypto";
import {
  checkJournalMark,
  type JournalFilter,
  type JournalMark,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import {
  type FontUsageSource,
  type SiteFontUsage,
  scanSiteFontUsage,
  type ThemeDocument,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** One cached scan: the journal mark its rows were read at, and its result. */
interface CachedUsage {
  readonly mark: JournalMark;
  readonly usage: SiteFontUsage;
}

/**
 * The journal rows that change what the scan reads. Every branch counts:
 * the scan reads every branch's rows (see the header). Plugin rows change
 * for many reasons (status, health, cost caps); only the two columns the
 * scan reads invalidate it.
 */
const FONT_USAGE_FILTER: JournalFilter = {
  kinds: ["module", "template", "layout", "content_instance", "page_module_content", "plugin"],
  columns: { plugin: ["slug", "source_code"] },
};

/**
 * (theme tokens, extra sources) → last scan. Small: one entry per theme
 * document being rendered (a few at a time), each a handful of numbers.
 * Bounded so a long-lived admin that previews many draft themes does not
 * grow without limit.
 */
const cache = new Map<string, CachedUsage>();
const MAX_CACHE_ENTRIES = 16;

/** Counts the full scans (cache misses), for the regression tests. */
let scanCount = 0;

function cacheKey(tokens: ThemeDocument, extraSources: readonly FontUsageSource[]): string {
  const hash = createHash("sha256").update(JSON.stringify(tokens));
  for (const source of extraSources) {
    hash.update("\0").update(source.label).update("\0").update(source.text);
  }
  return hash.digest("hex");
}

/**
 * Scan the theme plus every stored site text for font usage, served from
 * the in-process cache while none of the scanned rows changed.
 *
 * @param extraSources texts rendered alongside stored ones that are not
 *   rows yet (a Genesis design draft being previewed); part of the cache key
 * @returns the result an uncached scan under `tx`'s snapshot gives
 */
export async function loadSiteFontUsage(
  tx: TransactionRunner,
  tokens: ThemeDocument,
  extraSources: readonly FontUsageSource[] = [],
): Promise<SiteFontUsage> {
  const key = cacheKey(tokens, extraSources);
  const cached = cache.get(key);
  // One statement, hit or miss. The mark is taken before the scan
  // statement: a change committing in between is unseen by the mark and
  // invalidates once, never the other way round.
  const { fresh, mark } = await checkJournalMark(tx, cached?.mark ?? null, FONT_USAGE_FILTER);
  if (cached !== undefined && fresh) return cached.usage;
  scanCount += 1;
  const rows = (await tx.execute(sql`
    SELECT src.label, src.text
      FROM (
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
      ) src
  `)) as unknown as { label: string; text: string }[];
  const sources: FontUsageSource[] = rows.map((row) => ({ label: row.label, text: row.text }));
  const usage = scanSiteFontUsage({ tokens, sources: [...sources, ...extraSources] });

  // A scan that saw this transaction's own uncommitted content writes is
  // not cached: if the transaction rolls back, no journal row would ever
  // tell a later reader that those rows vanished.
  if (!mark.dirty) {
    cache.delete(key);
    cache.set(key, { mark, usage });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return usage;
}

/** Test seam: forget every cached scan (the journal stays). */
export function clearSiteFontUsageCache(): void {
  cache.clear();
}

/** Test seam: how many full scans (cache misses) this process ran. */
export function siteFontUsageScanCount(): number {
  return scanCount;
}
