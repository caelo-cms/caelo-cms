// SPDX-License-Identifier: MPL-2.0

/**
 * The live record of every page (`live_page_versions`, migration 0710;
 * docs/dev/search-engine-feed.md): what production serves per page — its
 * URL and the fingerprint of what it shows — and since when.
 *
 * Only the runs that change production write it, inside the transaction
 * that records the run:
 *
 *   - a Stage stores what its build found changed against the record
 *     (`recordStagedChanges`) — nothing is live yet;
 *   - Publish live of that Stage (`applyStagedRun`) and an Owner's
 *     production build (`applyLiveChanges`) append those changes;
 *   - a rollback (`restoreLiveVersions`) appends the restored build's state,
 *     read back from the record as it stood when that build was live.
 *
 * The newest row per page is what is live. When the record moved between
 * a build and its Publish live (a rollback or an Owner's build in between),
 * the build's changes no longer describe the step from what is live to what
 * it ships; the state the build ships is then rebuilt (the record at the
 * build's base, plus its changes) and compared with what is live now.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type BuildSearchFeed,
  isAnnouncedKind,
  type PageChange,
  type PageVersionKind,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** A page's state in the record; `url` null when it is not live. */
interface RecordState {
  readonly url: string | null;
  readonly fingerprint: string | null;
  readonly pluginFingerprint: string | null;
  readonly changedAt: string;
}

/** One row to append to `live_page_versions`. */
interface VersionRow {
  readonly pageId: string;
  readonly kind: PageVersionKind;
  readonly url: string | null;
  readonly fingerprint: string | null;
  readonly pluginFingerprint: string | null;
  readonly prevUrl: string | null;
  readonly changedAt: string;
}

const INSERT_BATCH = 2_000;

const iso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** The newest row id of the record, or null while it is empty. */
export async function liveVersionsHead(tx: TransactionRunner): Promise<number | null> {
  const rows = (await tx.execute(
    sql`SELECT max(id)::text AS head FROM live_page_versions`,
  )) as unknown as { head: string | null }[];
  const head = rows[0]?.head ?? null;
  return head === null ? null : Number(head);
}

/**
 * One writer at a time. Releases already take turns (the live-release
 * lease); this transaction lock keeps the record's own invariant — each
 * append is computed against the head it follows — even if they did not.
 */
async function lockRecord(tx: TransactionRunner): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('caelo.live_page_versions'))`);
}

/** Every page's state as the record stood at row `head` (its newest row up to it). */
async function recordAt(
  tx: TransactionRunner,
  head: number | null,
): Promise<Map<string, RecordState>> {
  const out = new Map<string, RecordState>();
  if (head === null) return out;
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (page_id) page_id::text AS page_id, url, fingerprint,
           plugin_fingerprint, changed_at
    FROM live_page_versions
    WHERE id <= ${head}
    ORDER BY page_id, id DESC
  `)) as unknown as {
    page_id: string;
    url: string | null;
    fingerprint: string | null;
    plugin_fingerprint: string | null;
    changed_at: string | Date;
  }[];
  for (const r of rows) {
    out.set(r.page_id, {
      url: r.url,
      fingerprint: r.fingerprint,
      pluginFingerprint: r.plugin_fingerprint,
      changedAt: iso(r.changed_at),
    });
  }
  return out;
}

/** Append rows to the record for `runId`; returns how many search engines hear of. */
async function appendRows(
  tx: TransactionRunner,
  runId: string,
  rows: readonly VersionRow[],
): Promise<number> {
  for (let at = 0; at < rows.length; at += INSERT_BATCH) {
    const batch = rows.slice(at, at + INSERT_BATCH).map((r) => ({
      page_id: r.pageId,
      kind: r.kind,
      url: r.url,
      fingerprint: r.fingerprint,
      plugin_fingerprint: r.pluginFingerprint,
      prev_url: r.prevUrl,
      changed_at: r.changedAt,
    }));
    await tx.execute(sql`
      INSERT INTO live_page_versions
        (run_id, page_id, kind, url, fingerprint, plugin_fingerprint, prev_url, changed_at)
      SELECT ${runId}::uuid, x.page_id, x.kind, x.url, x.fingerprint, x.plugin_fingerprint,
             x.prev_url, x.changed_at
      FROM jsonb_to_recordset((${JSON.stringify(batch)}::text)::jsonb) AS x(
        page_id uuid, kind text, url text, fingerprint text, plugin_fingerprint text,
        prev_url text, changed_at timestamptz
      )
    `);
  }
  return rows.filter((r) => isAnnouncedKind(r.kind)).length;
}

/** Mark the run with the record's head after it, and with the feed and key it serves. */
async function stampRun(
  tx: TransactionRunner,
  runId: string,
  serves: { readonly feedUrl: string | null; readonly indexNowKey: string | null },
): Promise<void> {
  await tx.execute(sql`
    UPDATE deploy_runs
    SET live_versions_head = (SELECT max(id) FROM live_page_versions),
        feed_url = ${serves.feedUrl},
        indexnow_key = ${serves.indexNowKey}
    WHERE id = ${runId}::uuid
  `);
}

/**
 * A Stage: keep what its build found changed until a Publish live ships it.
 * The two newest Stages of the target keep their rows (this one and the one
 * before it), and so does every Stage a running Publish live ships
 * (`deploy_runs.promoted_from_run_id`): newer Stages may finish while it
 * uploads or waits for its turn.
 */
export async function recordStagedChanges(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly targetId: string; readonly feed: BuildSearchFeed },
): Promise<void> {
  const { runId, targetId, feed } = args;
  await tx.execute(sql`
    DELETE FROM staged_page_changes
    WHERE target_id = ${targetId}::uuid
      AND run_id <> ${runId}::uuid
      AND run_id IS DISTINCT FROM (
        SELECT id FROM deploy_runs
        WHERE target_id = ${targetId}::uuid AND status = 'succeeded' AND id <> ${runId}::uuid
        ORDER BY started_at DESC
        LIMIT 1
      )
      AND run_id NOT IN (
        SELECT promoted_from_run_id FROM deploy_runs
        WHERE status = 'running' AND promoted_from_run_id IS NOT NULL
      )
  `);
  for (let at = 0; at < feed.changes.length; at += INSERT_BATCH) {
    const batch = feed.changes.slice(at, at + INSERT_BATCH).map((c) => ({
      page_id: c.pageId,
      kind: c.kind,
      url: c.url,
      fingerprint: c.fingerprint,
      plugin_fingerprint: c.pluginFingerprint,
      prev_url: c.prevUrl,
      changed_at: c.changedAt,
    }));
    await tx.execute(sql`
      INSERT INTO staged_page_changes
        (target_id, run_id, page_id, kind, url, fingerprint, plugin_fingerprint, prev_url,
         changed_at)
      SELECT ${targetId}::uuid, ${runId}::uuid, x.page_id, x.kind, x.url, x.fingerprint,
             x.plugin_fingerprint, x.prev_url, x.changed_at
      FROM jsonb_to_recordset((${JSON.stringify(batch)}::text)::jsonb) AS x(
        page_id uuid, kind text, url text, fingerprint text, plugin_fingerprint text,
        prev_url text, changed_at timestamptz
      )
    `);
  }
  await tx.execute(sql`
    UPDATE deploy_runs
    SET live_versions_base = ${feed.base},
        feed_url = ${feed.feedUrl},
        indexnow_key = ${feed.indexNowKey},
        page_changes_recorded = true
    WHERE id = ${runId}::uuid
  `);
}

/**
 * What a Stage recorded for Publish live (`recordStagedChanges`), or null
 * for a Stage from before the record existed: it recorded nothing.
 */
export async function readStagedChanges(
  tx: TransactionRunner,
  runId: string,
): Promise<BuildSearchFeed | null> {
  const run = (
    (await tx.execute(sql`
      SELECT live_versions_base::text AS base, feed_url, indexnow_key, page_changes_recorded
      FROM deploy_runs WHERE id = ${runId}::uuid
    `)) as unknown as {
      base: string | null;
      feed_url: string | null;
      indexnow_key: string | null;
      page_changes_recorded: boolean;
    }[]
  )[0];
  if (!run) throw new Error(`deploy run ${runId} not found — cannot read what its Stage changed`);
  // Missing rows of such a Stage are not "every page removed".
  if (!run.page_changes_recorded) return null;
  const rows = (await tx.execute(sql`
    SELECT page_id::text AS page_id, kind, url, fingerprint, plugin_fingerprint, prev_url,
           changed_at
    FROM staged_page_changes
    WHERE run_id = ${runId}::uuid
    ORDER BY page_id
  `)) as unknown as {
    page_id: string;
    kind: PageChange["kind"];
    url: string | null;
    fingerprint: string | null;
    plugin_fingerprint: string | null;
    prev_url: string | null;
    changed_at: string | Date;
  }[];
  return {
    base: run.base === null ? null : Number(run.base),
    changes: rows.map((r) => ({
      pageId: r.page_id,
      kind: r.kind,
      url: r.url,
      fingerprint: r.fingerprint,
      pluginFingerprint: r.plugin_fingerprint,
      prevUrl: r.prev_url,
      changedAt: iso(r.changed_at),
    })),
    feedUrl: run.feed_url,
    indexNowKey: run.indexnow_key,
  };
}

/** The kind of the step from `from` to `to` (both as recorded). */
function stepKind(from: RecordState | undefined, to: RecordState): PageVersionKind {
  if (to.url === null) return "removed";
  if (from === undefined || from.url === null) return "added";
  return from.url === to.url ? "changed" : "moved";
}

/** Same URL and fingerprints (both missing counts as the same: not live). */
function sameState(a: RecordState | undefined, b: RecordState | undefined): boolean {
  const aUrl = a?.url ?? null;
  const bUrl = b?.url ?? null;
  return (
    aUrl === bUrl &&
    (aUrl === null ||
      (a?.fingerprint === b?.fingerprint && a?.pluginFingerprint === b?.pluginFingerprint))
  );
}

/** Not live: no URL, no fingerprints. */
const notLive = (changedAt: string): RecordState => ({
  url: null,
  fingerprint: null,
  pluginFingerprint: null,
  changedAt,
});

/**
 * A build goes live (Publish live of a Stage, an Owner's production build):
 * append what it changes to the record.
 *
 * @param shippedAt - the date of a page whose change this build shows only
 *   because the record moved since it was built (the build's publish
 *   instant, as its other changes carry).
 * @returns how many rows search engines hear of.
 */
export async function applyLiveChanges(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly feed: BuildSearchFeed; readonly shippedAt: string },
): Promise<{ readonly announced: number }> {
  const { runId, feed } = args;
  await lockRecord(tx);
  const head = await liveVersionsHead(tx);
  let rows: VersionRow[];
  if (head === feed.base) {
    rows = feed.changes.map((c) => ({ ...c }));
  } else {
    rows = await reconcile(tx, {
      base: feed.base,
      head,
      changes: feed.changes,
      shippedAt: args.shippedAt,
    });
  }
  const announced = await appendRows(tx, runId, rows);
  await stampRun(tx, runId, { feedUrl: feed.feedUrl, indexNowKey: feed.indexNowKey });
  return { announced };
}

/**
 * The step from what is live now (`head`) to what the build ships: the
 * record at the build's `base` with its `changes` applied.
 */
async function reconcile(
  tx: TransactionRunner,
  args: {
    readonly base: number | null;
    readonly head: number | null;
    readonly changes: readonly PageChange[];
    readonly shippedAt: string;
  },
): Promise<VersionRow[]> {
  const atBase = await recordAt(tx, args.base);
  const now = await recordAt(tx, args.head);
  const shipped = new Map(atBase);
  const changeOf = new Map(args.changes.map((c) => [c.pageId, c]));
  for (const c of args.changes) {
    shipped.set(c.pageId, {
      url: c.url,
      fingerprint: c.fingerprint,
      pluginFingerprint: c.pluginFingerprint,
      changedAt: c.changedAt,
    });
  }
  const rows: VersionRow[] = [];
  for (const pageId of new Set([...shipped.keys(), ...now.keys()])) {
    const to = shipped.get(pageId) ?? notLive(args.shippedAt);
    const from = now.get(pageId);
    if (sameState(from, to)) continue;
    const change = changeOf.get(pageId);
    // A page the record has never seen stays the baseline it was built as.
    const kind =
      change?.kind === "baseline" && from === undefined ? "baseline" : stepKind(from, to);
    // Removing a page the record never had live changes nothing.
    if (kind === "removed" && (from === undefined || from.url === null)) continue;
    rows.push({
      pageId,
      kind,
      url: to.url,
      fingerprint: to.url === null ? null : to.fingerprint,
      pluginFingerprint: to.url === null ? null : to.pluginFingerprint,
      prevUrl: from?.url ?? null,
      changedAt: change?.changedAt ?? args.shippedAt,
    });
  }
  return rows;
}

/** A Publish live of a Stage: its recorded changes go live. */
export async function applyStagedRun(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly fromRunId: string; readonly shippedAt: string },
): Promise<{ readonly announced: number }> {
  const feed = await readStagedChanges(tx, args.fromRunId);
  if (feed === null) {
    // A Stage from before the record existed: its build serves no feed and
    // no key, and the record stays as it is until a recorded Stage goes live.
    await stampRun(tx, args.runId, { feedUrl: null, indexNowKey: null });
    return { announced: 0 };
  }
  return applyLiveChanges(tx, { runId: args.runId, feed, shippedAt: args.shippedAt });
}

/** What a plugin-data build found baked into one live page it re-baked. */
export interface PluginDigest {
  readonly pageId: string;
  /** `pluginRegionsDigest` of the page's live file after the re-bake. */
  readonly pluginFingerprint: string | null;
}

/** A page whose baked plugin content changed live, as the record has it. */
export interface PluginDataChange {
  readonly pageId: string;
  readonly url: string;
  readonly fingerprint: string;
  readonly pluginFingerprint: string | null;
}

/**
 * The live pages a plugin-data build changes: those whose re-baked plugin
 * content differs from the record. A page the record does not hold live is
 * left out — it reaches the record with the next Publish live.
 */
export async function pluginDataChanges(
  tx: TransactionRunner,
  digests: readonly PluginDigest[],
): Promise<PluginDataChange[]> {
  if (digests.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (v.page_id) v.page_id::text AS page_id, v.url, v.fingerprint,
           v.plugin_fingerprint
    FROM live_page_versions v
    WHERE v.page_id IN (
      SELECT jsonb_array_elements_text((${JSON.stringify(digests.map((d) => d.pageId))}::text)::jsonb)::uuid
    )
    ORDER BY v.page_id, v.id DESC
  `)) as unknown as {
    page_id: string;
    url: string | null;
    fingerprint: string | null;
    plugin_fingerprint: string | null;
  }[];
  const live = new Map(rows.map((r) => [r.page_id, r]));
  const out: PluginDataChange[] = [];
  for (const d of digests) {
    const r = live.get(d.pageId);
    if (!r || r.url === null || r.fingerprint === null) continue;
    if (r.plugin_fingerprint === d.pluginFingerprint) continue;
    out.push({
      pageId: d.pageId,
      url: r.url,
      fingerprint: r.fingerprint,
      pluginFingerprint: d.pluginFingerprint,
    });
  }
  return out.sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0));
}

/**
 * A plugin-data release (#1155) went live: the pages whose baked plugin
 * content changed get a `changed` row dated `changedAt` (when that content
 * went live), and the run serves its base release's feed and key file with
 * those pages' entries brought up to date. The run's head is the record
 * after it, so a rollback to it restores what it serves.
 *
 * @returns how many rows search engines hear of.
 */
export async function applyPluginDataChanges(
  tx: TransactionRunner,
  args: {
    readonly runId: string;
    readonly digests: readonly PluginDigest[];
    readonly changedAt: string;
  },
): Promise<{ readonly announced: number }> {
  await lockRecord(tx);
  const changes = await pluginDataChanges(tx, args.digests);
  const announced = await appendRows(
    tx,
    args.runId,
    changes.map((c) => ({
      pageId: c.pageId,
      kind: "changed" as const,
      url: c.url,
      fingerprint: c.fingerprint,
      pluginFingerprint: c.pluginFingerprint,
      prevUrl: c.url,
      changedAt: args.changedAt,
    })),
  );
  const base = (
    (await tx.execute(sql`
      SELECT b.feed_url, b.indexnow_key
      FROM deploy_runs r JOIN deploy_runs b ON b.id = r.base_run_id
      WHERE r.id = ${args.runId}::uuid
    `)) as unknown as { feed_url: string | null; indexnow_key: string | null }[]
  )[0];
  await stampRun(tx, args.runId, {
    feedUrl: base?.feed_url ?? null,
    indexNowKey: base?.indexnow_key ?? null,
  });
  return { announced };
}

/**
 * A rollback put `restoredRunId`'s build live again: the record gets that
 * build's state back, dated `at` (live content did change at that moment).
 * A build from before the record began has no state to restore; then
 * nothing is appended and the record keeps describing the newer build until
 * the next Publish live (`restorable: false`).
 */
export async function restoreLiveVersions(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly restoredRunId: string; readonly at: string },
): Promise<{ readonly announced: number; readonly restorable: boolean }> {
  const restored = (
    (await tx.execute(sql`
      SELECT live_versions_head::text AS head, feed_url, indexnow_key
      FROM deploy_runs WHERE id = ${args.restoredRunId}::uuid
    `)) as unknown as {
      head: string | null;
      feed_url: string | null;
      indexnow_key: string | null;
    }[]
  )[0];
  if (!restored)
    throw new Error(`deploy run ${args.restoredRunId} not found — cannot restore its record`);
  const serves = { feedUrl: restored.feed_url, indexNowKey: restored.indexnow_key };
  if (restored.head === null) {
    await stampRun(tx, args.runId, serves);
    return { announced: 0, restorable: false };
  }
  await lockRecord(tx);
  const target = await recordAt(tx, Number(restored.head));
  const now = await recordAt(tx, await liveVersionsHead(tx));
  const rows: VersionRow[] = [];
  for (const pageId of new Set([...target.keys(), ...now.keys()])) {
    const to = target.get(pageId) ?? notLive(args.at);
    const from = now.get(pageId);
    if (sameState(from, to)) continue;
    if (to.url === null && (from === undefined || from.url === null)) continue;
    rows.push({
      pageId,
      kind: to.url === null ? "removed" : "restored",
      url: to.url,
      fingerprint: to.url === null ? null : to.fingerprint,
      pluginFingerprint: to.url === null ? null : to.pluginFingerprint,
      prevUrl: from?.url ?? null,
      changedAt: args.at,
    });
  }
  const announced = await appendRows(tx, args.runId, rows);
  await stampRun(tx, args.runId, serves);
  return { announced, restorable: true };
}
