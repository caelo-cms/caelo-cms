// SPDX-License-Identifier: MPL-2.0

/**
 * The WebSub ping and the IndexNow submission of a production run
 * (`search_engine_notifications`, migration 0710; docs/dev/search-engine-feed.md).
 *
 * `queueSearchNotifications` runs in the transaction that records the run,
 * so a recorded Publish live always has its notifications queued. The send
 * happens after the commit, inside the same request (notify.ts), and the
 * scheduler tick retries what is still due — nothing waits on an idle
 * instance's CPU (CLAUDE.md §11.B Tier 5).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { isPublicSiteHost } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** Why notifications are not sent at all on this install, or null when they are. */
export function searchNotifyDisabledReason(env: Record<string, string | undefined>): string | null {
  return env.CAELO_SEARCH_NOTIFY === "off"
    ? "search engine notifications are switched off on this install (CAELO_SEARCH_NOTIFY=off)"
    : null;
}

/** The distinct URLs a run announces: where its changed pages are live now and were before. */
export async function announcedUrls(tx: TransactionRunner, runId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT u FROM (
      SELECT url AS u FROM live_page_versions
      WHERE run_id = ${runId}::uuid AND kind <> 'baseline' AND url IS NOT NULL
      UNION
      SELECT prev_url AS u FROM live_page_versions
      WHERE run_id = ${runId}::uuid AND kind <> 'baseline' AND prev_url IS NOT NULL
    ) x
    ORDER BY u
  `)) as unknown as { u: string }[];
  return rows.map((r) => r.u);
}

/**
 * Queue what the production run `runId` announces: a WebSub ping when its
 * feed changed (an announced page, or a feed newly served), an IndexNow
 * submission when it announces URLs and serves a key. Rows that cannot be
 * sent are queued as `skipped` with the reason, so Settings → SEO says why.
 *
 * @param announced - rows of the run search engines hear of (live-versions.ts).
 */
export async function queueSearchNotifications(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly announced: number },
): Promise<void> {
  const run = (
    (await tx.execute(sql`
      SELECT target_id::text AS target_id, feed_url, indexnow_key
      FROM deploy_runs WHERE id = ${args.runId}::uuid
    `)) as unknown as { target_id: string; feed_url: string | null; indexnow_key: string | null }[]
  )[0];
  if (!run) throw new Error(`deploy run ${args.runId} not found — cannot queue its notifications`);
  const previousFeed = (
    (await tx.execute(sql`
      SELECT feed_url FROM deploy_runs
      WHERE target_id = ${run.target_id}::uuid AND status = 'succeeded' AND id <> ${args.runId}::uuid
      ORDER BY started_at DESC
      LIMIT 1
    `)) as unknown as { feed_url: string | null }[]
  )[0]?.feed_url;
  const baseUrl = (
    (await tx.execute(sql`SELECT site_base_url FROM site_defaults WHERE id = 1`)) as unknown as {
      site_base_url: string | null;
    }[]
  )[0]?.site_base_url;
  const host = baseUrl ? new URL(baseUrl).hostname : "";
  const skipped =
    searchNotifyDisabledReason(process.env) ??
    (isPublicSiteHost(host)
      ? null
      : `the site address ${host || "(not set)"} cannot be reached from the internet, so search engines could not fetch what they are told about`);

  const queue = async (channel: "websub" | "indexnow", urlCount: number): Promise<void> => {
    await tx.execute(sql`
      INSERT INTO search_engine_notifications
        (run_id, channel, status, url_count, next_attempt_at, detail, finished_at)
      VALUES (
        ${args.runId}::uuid, ${channel}, ${skipped === null ? "pending" : "skipped"}, ${urlCount},
        ${skipped === null ? sql`clock_timestamp()` : sql`NULL`}, ${skipped},
        ${skipped === null ? sql`NULL` : sql`clock_timestamp()`}
      )
      ON CONFLICT (run_id, channel) DO NOTHING
    `);
  };

  if (run.feed_url !== null && (args.announced > 0 || previousFeed !== run.feed_url)) {
    // The hub fetches the feed as it is when the ping arrives: a newer ping
    // covers every older one still waiting.
    await tx.execute(sql`
      UPDATE search_engine_notifications
      SET status = 'skipped', next_attempt_at = NULL, finished_at = clock_timestamp(),
          detail = 'a later Publish live pinged the hub for the same feed'
      WHERE status = 'pending' AND channel = 'websub' AND run_id <> ${args.runId}::uuid
    `);
    await queue("websub", 1);
  }
  if (run.indexnow_key !== null && args.announced > 0) {
    const urls = await announcedUrls(tx, args.runId);
    if (urls.length > 0) await queue("indexnow", urls.length);
  }
}
