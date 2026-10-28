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
 * unchanged. Freshness is proven against the database, not guessed: the
 * scan records the Postgres snapshot it read, and every write to the six
 * scanned tables leaves its transaction id in `font_usage_changes`
 * (migration 0395 explains why that is a change log and not a counter). A
 * cached result is served only when the reader's snapshot has seen every
 * transaction the cached one saw and no change row it can see is missing
 * from the cached snapshot — then both snapshots see the same rows, so a
 * fresh scan would return the same result. Preview and build call this
 * same function, so they share the cache and stay in parity.
 */

import { createHash } from "node:crypto";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type FontUsageSource,
  type SiteFontUsage,
  scanSiteFontUsage,
  type ThemeDocument,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** One cached scan: the snapshot its rows were read under, and its result. */
interface CachedUsage {
  /** `pg_current_snapshot()` of the scan statement, as text. */
  readonly snapshot: string;
  /**
   * The scanning transaction's own xid, when it had one. Postgres treats a
   * transaction's own xid as visible in the snapshots it takes, but the
   * scan only saw that transaction's writes made BEFORE the scan; a later
   * content write by it must still invalidate, so the check treats this
   * xid as unseen.
   */
  readonly ownXid: string | null;
  readonly usage: SiteFontUsage;
}

/**
 * (theme tokens, extra sources) → last scan. Small: one entry per theme
 * document being rendered (a few at a time), each a handful of numbers.
 * Bounded so a long-lived admin that previews many draft themes does not
 * grow without limit.
 */
const cache = new Map<string, CachedUsage>();
const MAX_CACHE_ENTRIES = 16;

/**
 * Finished change rows that trigger a garbage-collection pass. The
 * freshness check only reads the recent tail of the log, so it may grow
 * this far before a writable miss trims it; one pass deletes at most this
 * many rows and never waits on a lock.
 */
const GC_THRESHOLD = 1000;

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
 * Whether the rows the cached scan read are exactly the rows `tx` sees
 * now. One statement, so every check uses the reader's single snapshot.
 */
async function isFresh(tx: TransactionRunner, entry: CachedUsage): Promise<boolean> {
  const rows = (await tx.execute(sql`
    WITH c AS (SELECT ${entry.snapshot}::pg_snapshot AS s, ${entry.ownXid}::xid8 AS own),
         r AS (SELECT pg_current_snapshot() AS s)
    SELECT (
      -- The reader has seen every transaction the cached snapshot saw, so
      -- nothing the cached scan included is invisible to the reader.
      pg_snapshot_xmax(c.s) <= pg_snapshot_xmax(r.s)
      AND NOT EXISTS (
        SELECT 1 FROM pg_snapshot_xip(r.s) AS x(xid)
         WHERE x.xid < pg_snapshot_xmax(c.s) AND pg_visible_in_snapshot(x.xid, c.s)
      )
      -- No change the reader sees (its own included) is unseen by the cache.
      AND NOT EXISTS (
        SELECT 1 FROM font_usage_changes f
         WHERE f.kind = 'change'
           AND (f.xid >= pg_snapshot_xmin(c.s) OR f.xid = c.own)
           AND (NOT pg_visible_in_snapshot(f.xid, c.s) OR f.xid = c.own)
      )
      -- No garbage collection removed a row the comparison above needs.
      AND NOT EXISTS (
        SELECT 1 FROM font_usage_changes f
         WHERE f.kind = 'horizon' AND f.horizon > pg_snapshot_xmin(c.s)
      )
    ) AS fresh
    FROM c, r
  `)) as unknown as { fresh: boolean }[];
  return rows[0]?.fresh === true;
}

/**
 * Trim finished rows from the change log. Rows below this transaction's
 * snapshot xmin belong to transactions that ended; the horizon row left
 * behind makes every cached snapshot older than that xmin stale, so no
 * reader compares against a row that is gone. Locked rows (another pass
 * running) are skipped, never waited for.
 */
async function collectGarbage(tx: TransactionRunner): Promise<void> {
  await tx.execute(sql`
    WITH h AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin),
    victims AS (
      SELECT f.kind, f.xid FROM font_usage_changes f, h
       WHERE f.xid < h.xmin
       ORDER BY f.kind, f.xid
       LIMIT ${GC_THRESHOLD}
       FOR UPDATE OF f SKIP LOCKED
    ),
    removed AS (
      DELETE FROM font_usage_changes f USING victims v
       WHERE f.kind = v.kind AND f.xid = v.xid
       RETURNING 1
    )
    -- Keyed by this transaction's own xid: concurrent passes sharing one
    -- xmin insert different keys, so none waits on another's uncommitted
    -- row. A second pass in the same transaction raises its own horizon.
    INSERT INTO font_usage_changes (kind, xid, horizon)
      SELECT 'horizon', pg_current_xact_id(), h.xmin FROM h WHERE EXISTS (SELECT 1 FROM removed)
      ON CONFLICT (kind, xid) DO UPDATE
        SET horizon = GREATEST(font_usage_changes.horizon, EXCLUDED.horizon)
  `);
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
  if (cached !== undefined && (await isFresh(tx, cached))) return cached.usage;

  // Snapshot, own xid and the "this transaction already wrote content"
  // flag come from the scan statement itself, so they describe exactly the
  // rows the scan read.
  scanCount += 1;
  const rows = (await tx.execute(sql`
    WITH meta AS (
      SELECT pg_current_snapshot()::text AS snapshot,
             pg_current_xact_id_if_assigned()::text AS own_xid,
             EXISTS (
               SELECT 1 FROM font_usage_changes
                WHERE kind = 'change' AND xid = pg_current_xact_id_if_assigned()
             ) AS dirty,
             current_setting('transaction_read_only') = 'off' AND (
               SELECT count(*) FROM (
                 SELECT 1 FROM font_usage_changes
                  WHERE xid < pg_snapshot_xmin(pg_current_snapshot())
                  LIMIT ${GC_THRESHOLD}
               ) finished
             ) >= ${GC_THRESHOLD} AS gc_due
    )
    SELECT meta.snapshot, meta.own_xid, meta.dirty, meta.gc_due, src.label, src.text
      FROM meta LEFT JOIN (
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
      ) src ON true
  `)) as unknown as {
    snapshot: string;
    own_xid: string | null;
    dirty: boolean;
    gc_due: boolean;
    label: string | null;
    text: string;
  }[];
  const meta = rows[0];
  if (meta === undefined) throw new Error("FontUsageScanReturnedNoSnapshot");
  const sources: FontUsageSource[] = [];
  for (const row of rows) {
    if (row.label !== null) sources.push({ label: row.label, text: row.text });
  }
  const usage = scanSiteFontUsage({ tokens, sources: [...sources, ...extraSources] });

  // A scan that saw this transaction's own uncommitted content writes is
  // not cached: if the transaction rolls back, no change row would ever
  // tell a later reader that those rows vanished.
  if (!meta.dirty) {
    cache.delete(key);
    cache.set(key, { snapshot: meta.snapshot, ownXid: meta.own_xid, usage });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  if (meta.gc_due) await collectGarbage(tx);
  return usage;
}

/** Test seam: forget every cached scan (the database log stays). */
export function clearSiteFontUsageCache(): void {
  cache.clear();
}

/** Test seam: how many full scans (cache misses) this process ran. */
export function siteFontUsageScanCount(): number {
  return scanCount;
}
