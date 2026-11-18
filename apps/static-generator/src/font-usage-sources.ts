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
 * Only the texts the scan can draw anything from are kept
 * (`fontUsageRelevant`: they contain `font` or `--`); the scan of those is
 * the scan of all, so a site's thousands of plain content values cost
 * nothing past the read that drops them.
 *
 * Carried forward, not re-read (issue #1270). The first scan of a process
 * reads every row once; it records the journal mark it read at (#1267,
 * docs/dev/state-and-changes.md). A later reader proves in one statement
 * whether any scanned row changed since; when one did, it reads the
 * journal rows between the cached mark and its own (`readChanges`) and
 * re-reads only the rows they name, by id. Before, every module or content
 * write anywhere invalidated the cache and the next preview read the whole
 * site again: under parallel agents that was every preview (searchVIU,
 * 2026-11-15, 15 agents on a db-f1-micro). A carried-forward set and a
 * whole read at the same mark hold the same texts, and the scan sorts them
 * the same way, so both give the same result (the maintained == rebuilt
 * test in `font-reads.integration.test.ts`).
 *
 * A reader reads the whole site instead when a delta cannot be exact or
 * would not be cheaper: it already wrote scanned rows itself (a dirty
 * mark: a rollback would leave no journal row), its snapshot does not
 * follow the cached mark (an older transaction must not see newer rows), the
 * journal lost rows the comparison needs, a truncate, or more than
 * {@link MAX_DELTA_CHANGES} journal rows (a Stage of a whole draft).
 * Preview and build call this same function, so they share the cache and
 * stay in parity.
 */

import { createHash } from "node:crypto";
import {
  checkJournalMark,
  type JournalFilter,
  type JournalMark,
  readChanges,
  snapshotFollows,
  type TransactionRunner,
  uuidArray,
} from "@caelo-cms/query-api";
import {
  type FontUsageSource,
  fontUsageRelevant,
  type SiteFontUsage,
  scanSiteFontUsage,
  type ThemeDocument,
} from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";

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
 * One scanned table: the label and text the scan reads per row, and the
 * rows that count. Their order is the order the scan sees the texts in
 * (by table, then by row id), so a whole read and a delta agree on the
 * first uncertainty reasons the result names.
 */
interface ScannedTable {
  readonly label: SQL;
  readonly text: SQL;
  readonly where: SQL;
}

const SCANNED_TABLES: Readonly<Record<string, ScannedTable>> = {
  modules: {
    label: sql`'module:' || slug`,
    text: sql`html || E'\n' || css || E'\n' || js || E'\n' || fields::text`,
    where: sql`deleted_at IS NULL`,
  },
  templates: {
    label: sql`'template:' || slug`,
    text: sql`html || E'\n' || css`,
    where: sql`deleted_at IS NULL`,
  },
  layouts: {
    label: sql`'layout:' || slug`,
    text: sql`html || E'\n' || css`,
    where: sql`deleted_at IS NULL`,
  },
  content_instances: {
    label: sql`'content:' || COALESCE(slug, id::text)`,
    text: sql`"values"::text`,
    where: sql`deleted_at IS NULL`,
  },
  page_module_content: {
    label: sql`'placement:' || id::text`,
    text: sql`content_values::text`,
    where: sql`true`,
  },
  plugins: {
    label: sql`'plugin:' || slug`,
    text: sql`source_code`,
    where: sql`source_code IS NOT NULL`,
  },
};
const TABLE_ORDER = Object.keys(SCANNED_TABLES);

/**
 * Above this many journal rows a reader reads the whole site instead: the
 * re-reads by id stop being cheaper well before the site's size, and a
 * Stage of a whole draft is a rare, already expensive moment.
 */
export const MAX_DELTA_CHANGES = 2000;

/** The relevant texts of the site at one journal mark. Never mutated. */
interface SourceSet {
  readonly mark: JournalMark;
  /** `<table>:<row id>` → the row's text, only rows {@link fontUsageRelevant} keeps. */
  readonly sources: ReadonlyMap<string, FontUsageSource>;
  /** The scan per theme and extra sources over {@link sources}; shared while they are. */
  readonly usage: Map<string, SiteFontUsage>;
}

/** The texts of the newest read; null before the first. */
let cached: SourceSet | null = null;
/** Scans kept per set: one per theme document being rendered. */
const MAX_USAGE_ENTRIES = 16;

/** How this process read the texts, for the regression tests. */
const reads = { whole: 0, deltaRows: 0 };

function usageKey(tokens: ThemeDocument, extraSources: readonly FontUsageSource[]): string {
  const hash = createHash("sha256").update(JSON.stringify(tokens));
  for (const source of extraSources) {
    hash.update("\0").update(source.label).update("\0").update(source.text);
  }
  return hash.digest("hex");
}

/** The rows of `ids` per table (every row of a table when its list is null). */
async function readRows(
  tx: TransactionRunner,
  ids: ReadonlyMap<string, readonly string[] | null>,
): Promise<{ key: string; label: string; text: string }[]> {
  const parts: SQL[] = [];
  for (const table of TABLE_ORDER) {
    if (!ids.has(table)) continue;
    const t = SCANNED_TABLES[table] as ScannedTable;
    const rowIds = ids.get(table) ?? null;
    const only = rowIds === null ? sql`` : sql` AND id = ANY(${uuidArray(rowIds)})`;
    // No text filter here: the whole read runs once per process, and a
    // filter on the text would make it a filtered full scan the index gate
    // rejects (docs/dev/query-index-gate.md). The caller keeps the relevant
    // texts (`relevantOf`).
    parts.push(sql`
      SELECT ${table}::text || ':' || id::text AS key, ${t.label} AS label, ${t.text} AS text
        FROM ${sql.identifier(table)}
       WHERE ${t.where}${only}`);
  }
  if (parts.length === 0) return [];
  return (await tx.execute(sql.join(parts, sql` UNION ALL `))) as unknown as {
    key: string;
    label: string;
    text: string;
  }[];
}

function relevantOf(
  rows: readonly { key: string; label: string; text: string }[],
): Map<string, FontUsageSource> {
  const out = new Map<string, FontUsageSource>();
  for (const r of rows) {
    if (fontUsageRelevant(r.text)) out.set(r.key, { label: r.label, text: r.text });
  }
  return out;
}

async function readWhole(tx: TransactionRunner): Promise<Map<string, FontUsageSource>> {
  reads.whole += 1;
  return relevantOf(await readRows(tx, new Map(TABLE_ORDER.map((t) => [t, null]))));
}

/**
 * `base` carried forward to `to` by the journal rows between them, or null
 * when only a whole read is exact or cheaper (see the file header).
 */
async function readDelta(
  tx: TransactionRunner,
  base: SourceSet,
  to: JournalMark,
): Promise<ReadonlyMap<string, FontUsageSource> | null> {
  const read = await readChanges(tx, {
    cursor: base.mark.snapshot,
    target: to.snapshot,
    after: null,
    filter: FONT_USAGE_FILTER,
    limit: MAX_DELTA_CHANGES,
    ownXid: base.mark.ownXid,
  });
  if (read.needsRebuild || read.more) return null;
  const ids = new Map<string, Set<string>>();
  for (const c of read.changes) {
    if (c.op === "truncate") return null;
    // The kinds also journal their snapshot tables (`module_snapshots`, …),
    // which the scan does not read: a pending state is rendered from its
    // row, and the row's own change arrives on its table.
    if (SCANNED_TABLES[c.table] === undefined) continue;
    let rows = ids.get(c.table);
    if (rows === undefined) {
      rows = new Set();
      ids.set(c.table, rows);
    }
    rows.add(c.rowId);
  }
  if (ids.size === 0) return base.sources;
  const asLists = new Map([...ids].map(([table, rows]) => [table, [...rows]]));
  reads.deltaRows += [...ids.values()].reduce((n, rows) => n + rows.size, 0);
  const fresh = relevantOf(await readRows(tx, asLists));
  const next = new Map(base.sources);
  let changed = false;
  for (const [table, rows] of ids) {
    for (const id of rows) {
      const key = `${table}:${id}`;
      const before = next.get(key);
      const source = fresh.get(key);
      if (source === undefined) {
        changed ||= before !== undefined;
        next.delete(key);
      } else {
        changed ||= before?.label !== source.label || before?.text !== source.text;
        next.set(key, source);
      }
    }
  }
  // A write that left every relevant text as it was (most content writes
  // carry no font CSS) keeps the base's texts, and with them its scans.
  return changed ? next : base.sources;
}

/** The texts in the order the scan reads them: by table, then by row id (code unit). */
function ordered(sources: ReadonlyMap<string, FontUsageSource>): FontUsageSource[] {
  const rank = (key: string) => TABLE_ORDER.indexOf(key.slice(0, key.indexOf(":")));
  return [...sources]
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([, source]) => source);
}

/**
 * Keep `set` unless the cache already holds a newer one: two readers can
 * finish in either order, and the later mark is the one that carries
 * forward to the most readers.
 */
function remember(set: SourceSet): void {
  if (cached === null || snapshotFollows(cached.mark.snapshot, set.mark.snapshot)) cached = set;
}

/**
 * The texts `tx` sees, from the cache when it can prove them current,
 * carried forward when it can, read whole otherwise.
 */
async function sourcesFor(tx: TransactionRunner): Promise<SourceSet> {
  // The base is the set cached before this reader's mark is taken, so the
  // mark follows it even when a concurrent reader caches a newer set
  // meanwhile.
  const base = cached;
  // One statement, hit or miss. The mark is taken before any read: a
  // change committing during the read is unseen by the mark and is
  // carried in once more by the next reader, never the other way round.
  const { fresh, mark } = await checkJournalMark(tx, base?.mark ?? null, FONT_USAGE_FILTER);
  if (base !== null && fresh) return base;
  const sources =
    base !== null && !mark.dirty && snapshotFollows(base.mark.snapshot, mark.snapshot)
      ? await readDelta(tx, base, mark)
      : null;
  if (base !== null && sources !== null) {
    // Same texts: the scans of the base still hold.
    const set: SourceSet = {
      mark,
      sources,
      usage: sources === base.sources ? base.usage : new Map(),
    };
    remember(set);
    return set;
  }
  const set: SourceSet = { mark, sources: await readWhole(tx), usage: new Map() };
  // A read that saw this transaction's own uncommitted writes is not kept:
  // if the transaction rolls back, no journal row would ever tell a later
  // reader that those rows vanished.
  if (!mark.dirty) remember(set);
  return set;
}

/**
 * Scan the theme plus every stored site text for font usage, from the
 * texts this process holds, carried forward to `tx`'s snapshot.
 *
 * @param extraSources texts rendered alongside stored ones that are not
 *   rows yet (a Genesis design draft being previewed); part of the cache key
 * @returns the result a whole read under `tx`'s snapshot gives
 */
export async function loadSiteFontUsage(
  tx: TransactionRunner,
  tokens: ThemeDocument,
  extraSources: readonly FontUsageSource[] = [],
): Promise<SiteFontUsage> {
  const set = await sourcesFor(tx);
  const key = usageKey(tokens, extraSources);
  const known = set.usage.get(key);
  if (known !== undefined) return known;
  const usage = scanSiteFontUsage({ tokens, sources: [...ordered(set.sources), ...extraSources] });
  set.usage.set(key, usage);
  while (set.usage.size > MAX_USAGE_ENTRIES) {
    const oldest = set.usage.keys().next().value;
    if (oldest === undefined) break;
    set.usage.delete(oldest);
  }
  return usage;
}

/** Test seam: forget every cached text and scan (the journal stays). */
export function clearSiteFontUsageCache(): void {
  cached = null;
}

/** Test seam: how this process read the site's texts (whole reads, rows re-read by deltas). */
export function siteFontUsageReads(): { readonly whole: number; readonly deltaRows: number } {
  return { ...reads };
}
