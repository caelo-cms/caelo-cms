// SPDX-License-Identifier: MPL-2.0

/**
 * What a build changes about the live site, page by page
 * (docs/dev/search-engine-feed.md).
 *
 * `live_page_versions` records what production serves: per page its URL,
 * the fingerprint of what it shows and the date that last changed. A build
 * compares every indexable page it renders with that record:
 *
 *  - same URL and fingerprint — unchanged, it keeps its date;
 *  - otherwise `changed` / `moved` / `added`, dated `publishAt` (the run's
 *    start, the same instant `first_published_at` uses, so the dates in the
 *    feed, the sitemap and the database agree);
 *  - a page live before but not among them (unpublished, deleted, noindex)
 *    is `removed` — known only to a full build;
 *  - while the record is still empty (the first builds after the feed
 *    shipped), a page that was live already is the `baseline`: it keeps
 *    `pages.updated_at` as its date and is not announced.
 *
 * The build reports these changes; the run that ships the build to
 * production records them (admin-core `search-feed/live-versions.ts`).
 * Nothing here writes.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { FEED_ENTRY_LIMIT, type PageChange } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** A page's live state: `url` null when it is no longer live. */
interface LiveState {
  readonly url: string | null;
  readonly fingerprint: string | null;
  readonly pluginFingerprint: string | null;
  /** What its feed entry shows, as published; null when not live. */
  readonly title: string | null;
  readonly summary: string | null;
  readonly changedAt: string;
}

/** An indexable page the build rendered, as the SEO pass records it. */
export interface RecordedPage {
  readonly pageId: string;
  /** Its public URL (the canonical). */
  readonly url: string;
  readonly fingerprint: string;
  /** What the plugins baked into the page show (`pluginRegionsDigest`); null: none. */
  readonly pluginFingerprint: string | null;
  readonly title: string;
  /** The meta description ("" when none). */
  readonly summary: string;
  readonly firstPublishedAt: string | null;
  /** `pages.updated_at`: the baseline date of a page live before the record began. */
  readonly updatedAt: string;
}

/** One entry of the feed. */
export interface FeedEntry {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly summary: string;
  readonly changedAt: string;
  readonly publishedAt: string;
}

/** What {@link ContentStates.finish} reports. */
export interface ContentStatesResult {
  readonly base: number | null;
  readonly changes: PageChange[];
  /** The {@link FEED_ENTRY_LIMIT} pages changed last, newest first. */
  readonly feed: FeedEntry[];
}

const iso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** The page states of one build: loaded once, recorded batch by batch. */
export class ContentStates {
  private readonly recorded = new Map<
    string,
    { readonly page: RecordedPage; readonly changedAt: string }
  >();
  private readonly changes: PageChange[] = [];

  private constructor(
    private readonly base: number | null,
    private readonly live: ReadonlyMap<string, LiveState>,
    private readonly publishAt: string,
    private readonly full: boolean,
  ) {}

  /**
   * Read the live record as it stands now (one statement over the log, its
   * newest row per page).
   *
   * @param full - true when the build renders every published page: only
   *   then does a page missing from it count as removed.
   */
  static async load(
    tx: TransactionRunner,
    args: { readonly publishAt: string; readonly full: boolean },
  ): Promise<ContentStates> {
    const head = (
      (await tx.execute(sql`SELECT max(id)::text AS head FROM live_page_versions`)) as unknown as {
        head: string | null;
      }[]
    )[0]?.head;
    const base = head === null || head === undefined ? null : Number(head);
    const live = new Map<string, LiveState>();
    if (base !== null) {
      const rows = (await tx.execute(sql`
        SELECT DISTINCT ON (page_id) page_id::text AS page_id, url, fingerprint,
               plugin_fingerprint, title, summary, changed_at
        FROM live_page_versions
        WHERE id <= ${base}
        ORDER BY page_id, id DESC
      `)) as unknown as {
        page_id: string;
        url: string | null;
        fingerprint: string | null;
        plugin_fingerprint: string | null;
        title: string | null;
        summary: string | null;
        changed_at: string | Date;
      }[];
      for (const r of rows) {
        live.set(r.page_id, {
          url: r.url,
          fingerprint: r.fingerprint,
          pluginFingerprint: r.plugin_fingerprint,
          title: r.title,
          summary: r.summary,
          changedAt: iso(r.changed_at),
        });
      }
    }
    return ContentStates.fromRecord({ base, live, publishAt: args.publishAt, full: args.full });
  }

  /**
   * The states of a build over a record already read: `base` is its head
   * (null while empty), `live` its newest state per page.
   */
  static fromRecord(args: {
    readonly base: number | null;
    readonly live: ReadonlyMap<
      string,
      {
        readonly url: string | null;
        readonly fingerprint: string | null;
        readonly pluginFingerprint: string | null;
        readonly title: string | null;
        readonly summary: string | null;
        readonly changedAt: string;
      }
    >;
    readonly publishAt: string;
    readonly full: boolean;
  }): ContentStates {
    return new ContentStates(args.base, args.live, iso(args.publishAt), args.full);
  }

  /** Record one indexable page (page 1 of a paginated overview). */
  record(page: RecordedPage): void {
    if (this.recorded.has(page.pageId)) {
      throw new Error(`content-states: page ${page.pageId} was recorded twice in one build`);
    }
    const live = this.live.get(page.pageId);
    let changedAt: string;
    let change: Omit<
      PageChange,
      "pageId" | "url" | "fingerprint" | "pluginFingerprint" | "title" | "summary"
    > | null;
    if (live === undefined) {
      // Never recorded. Before the first record (base null), a page that
      // was live already is the baseline: dated as the sitemap dated it
      // until now (never before it went live, never after this build), and
      // never announced.
      if (this.base === null && page.firstPublishedAt !== null) {
        const latest = Math.max(Date.parse(page.updatedAt), Date.parse(page.firstPublishedAt));
        changedAt = new Date(Math.min(latest, Date.parse(this.publishAt))).toISOString();
        change = { kind: "baseline", prevUrl: null, changedAt };
      } else {
        changedAt = this.publishAt;
        change = { kind: "added", prevUrl: null, changedAt };
      }
    } else if (live.url === null) {
      changedAt = this.publishAt;
      change = { kind: "added", prevUrl: null, changedAt };
    } else if (
      live.url === page.url &&
      live.fingerprint === page.fingerprint &&
      live.pluginFingerprint === page.pluginFingerprint
    ) {
      changedAt = live.changedAt;
      change = null;
    } else {
      changedAt = this.publishAt;
      change = {
        kind: live.url === page.url ? "changed" : "moved",
        prevUrl: live.url,
        changedAt,
      };
    }
    this.recorded.set(page.pageId, { page, changedAt });
    if (change !== null) {
      this.changes.push({
        pageId: page.pageId,
        url: page.url,
        fingerprint: page.fingerprint,
        pluginFingerprint: page.pluginFingerprint,
        title: page.title,
        summary: page.summary,
        ...change,
      });
    }
  }

  /** The date the sitemap shows for a recorded page. */
  changedAt(pageId: string): string {
    const r = this.recorded.get(pageId);
    if (r === undefined) {
      throw new Error(`content-states: page ${pageId} has no recorded state in this build`);
    }
    return r.changedAt;
  }

  /** After the last batch: the removed pages, and the feed. */
  async finish(tx: TransactionRunner): Promise<ContentStatesResult> {
    const changes = [...this.changes];
    if (this.full) {
      for (const [pageId, live] of this.live) {
        if (live.url === null || this.recorded.has(pageId)) continue;
        changes.push({
          pageId,
          kind: "removed",
          url: null,
          fingerprint: null,
          pluginFingerprint: null,
          title: null,
          summary: null,
          prevUrl: live.url,
          changedAt: this.publishAt,
        });
      }
    }
    const feed: FeedEntry[] = [...this.recorded.values()].map(({ page, changedAt }) => ({
      pageId: page.pageId,
      url: page.url,
      title: page.title,
      summary: page.summary,
      changedAt,
      publishedAt: page.firstPublishedAt === null ? this.publishAt : iso(page.firstPublishedAt),
    }));
    // An incremental build renders only the pages a change reached; the
    // rest stay live as recorded and keep their place in the feed.
    if (!this.full) feed.push(...(await this.liveFeedEntriesNotRecorded(tx)));
    feed.sort(byChangeDesc);
    return { base: this.base, changes, feed: feed.slice(0, FEED_ENTRY_LIMIT) };
  }

  /** The newest live pages this build did not render, as feed entries. */
  private async liveFeedEntriesNotRecorded(tx: TransactionRunner): Promise<FeedEntry[]> {
    const candidates = [...this.live]
      .filter(([pageId, s]) => s.url !== null && !this.recorded.has(pageId))
      .sort(([, a], [, b]) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : 0))
      .slice(0, FEED_ENTRY_LIMIT);
    if (candidates.length === 0) return [];
    // Title and summary as the record has them — what was published, never
    // a page row that may hold unpublished edits. The first publication is
    // a fact Publish live stamped.
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, first_published_at FROM pages
      WHERE id IN (
        SELECT jsonb_array_elements_text((${JSON.stringify(candidates.map(([id]) => id))}::text)::jsonb)::uuid
      )
    `)) as unknown as { id: string; first_published_at: string | Date | null }[];
    const published = new Map(rows.map((r) => [r.id, r.first_published_at]));
    return candidates.flatMap(([pageId, s]) => {
      const at = published.get(pageId);
      if (at === undefined || s.url === null || s.title === null || s.summary === null) return [];
      return [
        {
          pageId,
          url: s.url,
          title: s.title,
          summary: s.summary,
          changedAt: s.changedAt,
          publishedAt: at === null ? this.publishAt : iso(at),
        },
      ];
    });
  }
}

/** Newest change first; the URL orders a tie, so the feed is deterministic. */
function byChangeDesc(a: FeedEntry, b: FeedEntry): number {
  if (a.changedAt !== b.changedAt) return a.changedAt < b.changedAt ? 1 : -1;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}
