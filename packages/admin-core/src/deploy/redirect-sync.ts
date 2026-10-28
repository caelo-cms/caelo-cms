// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — redirects go live when they are saved, without a build.
 *
 * Redirects are not page content: they are answered by the hosting
 * provider in front of the static files (Firebase Hosting config, the GCP
 * URL map, the Caddy snippet). So a redirects write no longer waits for the
 * next build — and since #1154 there is no automatic build — but pushes the
 * table to the provider right after it commits:
 *
 *  1. In the write's transaction, {@link requestRedirectSync} bumps
 *     `redirect_sync_state.wanted_revision` of every target that can serve
 *     redirects (staging + production) and registers a post-commit effect.
 *  2. After the commit, that effect runs `redirects.sync_provider`, which
 *     calls {@link syncRedirectsInTx}: under the target's publish lock it
 *     reads the table, asks the publisher to put the plan live against the
 *     files of the build the target serves NOW (`StaticPublisher.syncRedirects`
 *     — the live page still wins, a draft page's path is not live yet), and
 *     records the attempt (`redirect_syncs`, audit) plus the revision the
 *     target now serves.
 *  3. A failed attempt leaves the target behind (wanted > synced), is shown
 *     in Settings → Redirects and the notification bell, is named in the
 *     redirect tools' results ("NOT live yet" + the error), and is retried
 *     with backoff by the redirect-sync worker. Never silent. It does not
 *     turn the write itself into an error: the write is saved, and a page
 *     slug change must not fail because the hosting was unreachable.
 *
 * Publish live and rollback run the same sync for their target inside their
 * own transaction after the files are live: the build they ship carries the
 * table as it was at its Stage, and the provider must end up with the table
 * as it is now.
 *
 * Revisions make "is the provider current?" exact without comparing tables:
 * the bump and the row change commit together, and the sync reads the
 * revision BEFORE the rows, so a sync can only record a revision whose rows
 * it has seen (a later write leaves the target behind and is synced again).
 */

import { afterCommit, type TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext, RedirectTableRow } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { lockLiveReleases } from "./live-release-lock.js";
import { resolveOutputRoot } from "./output-root.js";
import { tryLockStagingPublication } from "./staging-publication-lock.js";
import { loadStaticPublisher, type StaticPublisher } from "./static-publisher.js";

/** Why a sync ran. */
export type RedirectSyncTrigger = "save" | "build" | "publish" | "rollback" | "retry" | "manual";

/** Triggers that changed the build a target serves (see {@link syncRedirectsInTx}). */
const SERVED_BUILD_CHANGED: ReadonlySet<RedirectSyncTrigger> = new Set([
  "build",
  "publish",
  "rollback",
]);

/**
 * What one sync attempt did for one target. `nothing-live`: the target
 * serves no build yet, so there is nothing to put redirects in front of —
 * they go out with its first publish.
 */
export type RedirectSyncStatus = "applied" | "unchanged" | "not-served" | "nothing-live" | "failed";

/** One target's result of {@link syncRedirectsInTx}. */
export interface RedirectSyncOutcome {
  readonly targetId: string;
  readonly targetName: string;
  readonly env: "staging" | "production";
  readonly status: RedirectSyncStatus;
  readonly revision: number;
  readonly redirectCount: number | null;
  readonly unservedTargets: readonly { fromPath: string; location: string }[];
  readonly location: string | null;
  readonly error: string | null;
}

/** The deploy targets whose provider can serve redirects. */
const SYNC_ENVS = sql`('staging', 'production')`;

/** History rows kept per target. */
const HISTORY_PER_TARGET = 50;

/** Longest wait between two retries of a failing target. */
const MAX_BACKOFF_MINUTES = 60;

/**
 * Runs `redirects.sync_provider` after a redirects write commits; set by
 * {@link setRedirectSyncRunner} (the admin process, at boot). A process
 * without it (a test that does not exercise the sync) still records the
 * target as behind, which Settings shows and the worker of the next admin
 * process retries.
 */
type RedirectSyncRunner = (trigger: RedirectSyncTrigger) => Promise<RedirectSyncOutcome[]>;
let runner: RedirectSyncRunner | null = null;

/** Register (or with `null` remove) what runs the sync after a redirects write. */
export function setRedirectSyncRunner(next: RedirectSyncRunner | null): void {
  runner = next;
}

/** Transactions that already requested a sync (one per commit is enough). */
const requested = new WeakSet<TransactionRunner>();

/**
 * Mark every redirect-serving target as behind and, once `tx` commits,
 * push the table to the provider. Call from every write to the redirects
 * table, in the same transaction. Idempotent per transaction.
 */
export async function requestRedirectSync(
  tx: TransactionRunner,
  _ctx: ExecutionContext,
): Promise<void> {
  // ORDER BY: rows are locked in one order by every writer and by the sync
  // (which locks them by target_id too), so two of them cannot deadlock.
  await tx.execute(sql`
    INSERT INTO redirect_sync_state (target_id, wanted_revision)
    SELECT id, 1 FROM deploy_targets WHERE env IN ${SYNC_ENVS} ORDER BY id
    ON CONFLICT (target_id) DO UPDATE
      SET wanted_revision = redirect_sync_state.wanted_revision + 1,
          failed_attempts = 0,
          next_attempt_at = NULL,
          updated_at = now()
  `);
  if (requested.has(tx)) return;
  requested.add(tx);
  const run = runner;
  if (run === null) return;
  afterCommit(tx, {
    label: "put the saved redirects live on your hosting",
    // A failed push does not fail the write that triggered it (a slug change
    // must not report an error because the hosting was unreachable): it is
    // recorded, shown in Settings → Redirects and the bell, named in the
    // redirect tools' results, and retried by the worker.
    run: async () => {
      const outcomes = await run("save");
      for (const o of outcomes.filter((x) => x.status === "failed")) {
        console.error(
          "[redirect-sync] the saved redirects are not live yet; retried automatically",
          {
            target: o.targetName,
            error: o.error,
          },
        );
      }
    },
  });
}

/**
 * #1211 — mark `targetIds` as behind in the caller's transaction: the build
 * they serve changed and carries the redirects of its own build time. The
 * caller pushes the table after its commit (`redirects.sync_provider`), so
 * no provider I/O runs inside its transaction; should that push fail or
 * never run, the target stays behind and the worker retries it.
 */
export async function markRedirectsBehind(
  tx: TransactionRunner,
  targetIds: readonly string[],
): Promise<void> {
  if (targetIds.length === 0) return;
  const ids = sql.join(
    targetIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO redirect_sync_state (target_id, wanted_revision)
    SELECT id, 1 FROM deploy_targets WHERE env IN ${SYNC_ENVS} AND id IN (${ids}) ORDER BY id
    ON CONFLICT (target_id) DO UPDATE
      SET wanted_revision = redirect_sync_state.wanted_revision + 1, updated_at = now()
  `);
}

interface TargetRow {
  id: string;
  name: string;
  env: "staging" | "production";
  out_dir: string;
  base_url: string;
  robots_default: "index" | "noindex";
  page_url_style: "directory" | "no-extension" | null;
  wanted_revision: number | string;
  failed_attempts: number;
}

/**
 * Put the redirects table live on the given targets (default: every
 * staging and production target), recording each attempt. Never throws for
 * a provider failure — that is a `failed` outcome, recorded and scheduled
 * for retry — so a caller inside a publish can keep its own result.
 *
 * Takes the live-release lock before any production target and the
 * staging-publication lock before any staging target (that order, as every
 * publish does), so a sync never interleaves with a publish of the same
 * target: whichever runs second sees the other's result. Staging targets
 * are skipped (and stay behind) while a Stage holds the staging lease: that
 * Stage syncs them when it finishes (#1211).
 */
export async function syncRedirectsInTx(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  args: {
    readonly trigger: RedirectSyncTrigger;
    /** Limit to these deploy target ids (a publish syncs its own target). */
    readonly targetIds?: readonly string[];
    /** Where relative out_dirs resolve (defaults like deploy ops do). */
    readonly outputRoot?: string;
    /** Test seam; the provider's publisher otherwise. */
    readonly publisher?: StaticPublisher;
  },
): Promise<RedirectSyncOutcome[]> {
  const only = (column: string) =>
    args.targetIds === undefined
      ? sql``
      : args.targetIds.length === 0
        ? sql`AND false`
        : sql`AND ${sql.raw(column)} IN (${sql.join(
            args.targetIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  const envRows = (await tx.execute(sql`
    SELECT env FROM deploy_targets WHERE env IN ${SYNC_ENVS} ${only("id")}
  `)) as unknown as { env: string }[];
  if (envRows.length === 0) return [];
  if (envRows.some((r) => r.env === "production")) await lockLiveReleases(tx);
  // #1211 — a Stage that is publishing staging right now holds the lease
  // without a transaction to wait for. Once its run is recorded it syncs the table
  // as saved by then onto the build it serves, so staging targets are left
  // behind here (wanted > synced: Settings shows it, the worker retries
  // should that Stage fail) instead of waiting minutes inside this write.
  const skipStaging =
    envRows.some((r) => r.env === "staging") && !(await tryLockStagingPublication(tx)).locked;

  // A skipped staging target's state row is not touched at all: locking it
  // here would hold it across the provider calls below, and the Stage's own
  // finish step writes that row (it would wait past lock_timeout and roll
  // back its publication record).
  const envs = skipStaging ? sql`('production')` : SYNC_ENVS;

  await tx.execute(sql`
    INSERT INTO redirect_sync_state (target_id)
    SELECT id FROM deploy_targets WHERE env IN ${envs} ${only("id")} ORDER BY id
    ON CONFLICT (target_id) DO NOTHING
  `);
  // A new served build carries the redirects of its own build time, so the
  // provider may now serve an older table: the target is behind until this
  // sync succeeds, and a failure here is retried like a failed save.
  if (SERVED_BUILD_CHANGED.has(args.trigger)) {
    await tx.execute(sql`
      UPDATE redirect_sync_state SET wanted_revision = wanted_revision + 1, updated_at = now()
      WHERE target_id IN (SELECT id FROM deploy_targets WHERE env IN ${envs} ${only("id")})
    `);
  }
  // The revision first, then the rows (see the module comment).
  const targets = (await tx.execute(sql`
    SELECT t.id::text AS id, t.name, t.env, t.out_dir, t.base_url, t.robots_default,
           t.page_url_style, s.wanted_revision, s.failed_attempts
    FROM deploy_targets t JOIN redirect_sync_state s ON s.target_id = t.id
    WHERE t.env IN ${envs} ${only("t.id")}
    ORDER BY t.id
    FOR UPDATE OF s
  `)) as unknown as TargetRow[];
  const rows = (await tx.execute(sql`
    SELECT from_path, to_path, status_code FROM redirects ORDER BY from_path
  `)) as unknown as { from_path: string; to_path: string; status_code: number }[];
  const table: RedirectTableRow[] = rows.map((r) => ({
    fromPath: r.from_path,
    toPath: r.to_path,
    statusCode: r.status_code,
  }));
  const publisher = args.publisher ?? (await loadStaticPublisher(process.env.CAELO_PROVIDER));
  const outputRoot = resolveOutputRoot(args.outputRoot);

  const outcomes: RedirectSyncOutcome[] = [];
  // Production first: it is what visitors see.
  const ordered = [...targets].sort(
    (a, b) => Number(b.env === "production") - Number(a.env === "production"),
  );
  for (const t of ordered) {
    outcomes.push(await syncTarget(tx, ctx, args.trigger, t, table, publisher, outputRoot));
  }
  return outcomes;
}

async function syncTarget(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  trigger: RedirectSyncTrigger,
  t: TargetRow,
  table: readonly RedirectTableRow[],
  publisher: StaticPublisher,
  outputRoot: string,
): Promise<RedirectSyncOutcome> {
  const revision = Number(t.wanted_revision);
  const base = { targetId: t.id, targetName: t.name, env: t.env, revision };
  const servedRunId = await servedRun(tx, t);
  if (servedRunId === null) {
    const outcome: RedirectSyncOutcome = {
      ...base,
      status: "nothing-live",
      redirectCount: null,
      unservedTargets: [],
      location: null,
      error: null,
    };
    await record(tx, ctx, trigger, outcome, null);
    return outcome;
  }
  const target: DeployTarget = {
    id: t.id,
    name: t.name,
    env: t.env,
    outDir: t.out_dir,
    baseUrl: t.base_url,
    robotsDefault: t.robots_default,
    pageUrlStyle: t.page_url_style ?? "directory",
  };
  let outcome: RedirectSyncOutcome;
  try {
    const result = await publisher.syncRedirects({
      target,
      rows: table,
      servedRunId,
      outputRoot,
    });
    outcome = {
      ...base,
      status: result.outcome,
      redirectCount: result.redirectCount,
      unservedTargets: result.unservedTargets,
      location: result.location,
      error: null,
    };
    await record(tx, ctx, trigger, outcome, servedRunId, {
      gone: result.goneCount,
      shadowed: result.shadowedCount,
    });
    if (result.movedServedBuild !== undefined) {
      // The served build now lives at a new provider location (a new
      // Firebase Hosting version with the same files). A rollback reads a
      // run's recorded location, which release retention may delete once
      // redirect-only releases pile up — so the run that recorded the
      // copied version follows it. Matched by that version, not by which
      // run looks newest, so no other run's build can be pointed at.
      await tx.execute(sql`
        UPDATE deploy_runs
        SET publish_summary = jsonb_set(publish_summary, '{location}', to_jsonb(${result.movedServedBuild.to}::text))
        WHERE target_id = ${t.id}::uuid
          AND publish_summary->>'location' = ${result.movedServedBuild.from}
      `);
    }
  } catch (e) {
    outcome = {
      ...base,
      status: "failed",
      redirectCount: null,
      unservedTargets: [],
      location: null,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 4000),
    };
    await record(tx, ctx, trigger, outcome, servedRunId);
  }
  return outcome;
}

/**
 * The deploy run whose build `t` serves: production — its last released
 * succeeded run with a build (Publish live, rollback); staging — the run the staging
 * host serves (#650, `staging_access.origin_run_id`), else its newest
 * succeeded run. Null when nothing was ever published there.
 */
async function servedRun(tx: TransactionRunner, t: TargetRow): Promise<string | null> {
  if (t.env === "staging") {
    const origin = (await tx.execute(sql`
      SELECT s.origin_run_id::text AS run_id
      FROM staging_access s JOIN deploy_runs r ON r.id = s.origin_run_id
      WHERE s.id = 1 AND r.target_id = ${t.id}::uuid
    `)) as unknown as { run_id: string | null }[];
    if (origin[0]?.run_id) return origin[0].run_id;
  }
  // Release order, not start order: every publish and rollback marks its
  // run finished while it holds the target's publish lock, so the newest
  // finished_at is the build released last.
  const rows = (await tx.execute(sql`
    SELECT id::text AS id FROM deploy_runs
    WHERE target_id = ${t.id}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
    ORDER BY finished_at DESC NULLS LAST, started_at DESC LIMIT 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

async function record(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  trigger: RedirectSyncTrigger,
  o: RedirectSyncOutcome,
  servedRunId: string | null,
  counts: { gone: number; shadowed: number } | null = null,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO redirect_syncs
      (target_id, trigger, status, revision, served_run_id, redirect_count, gone_count,
       shadowed_count, unserved_targets, location, error_message, actor_id, request_id)
    VALUES (${o.targetId}::uuid, ${trigger}, ${o.status}, ${o.revision},
            ${servedRunId}::uuid, ${o.redirectCount}, ${counts?.gone ?? null},
            ${counts?.shadowed ?? null}, ${jsonbParam(o.unservedTargets)},
            ${o.location?.slice(0, 1000) ?? null}, ${o.error}, ${ctx.actorId}::uuid,
            ${ctx.requestId.slice(0, 200)})
  `);
  await tx.execute(sql`
    DELETE FROM redirect_syncs
    WHERE target_id = ${o.targetId}::uuid
      AND id NOT IN (
        SELECT id FROM redirect_syncs WHERE target_id = ${o.targetId}::uuid
        ORDER BY finished_at DESC, id DESC LIMIT ${HISTORY_PER_TARGET}
      )
  `);
  if (o.status === "failed") {
    await tx.execute(sql`
      UPDATE redirect_sync_state
      SET failed_attempts = failed_attempts + 1,
          next_attempt_at = clock_timestamp()
            + make_interval(mins => LEAST(power(2, LEAST(failed_attempts, 10))::int, ${MAX_BACKOFF_MINUTES})),
          last_error = ${o.error},
          updated_at = now()
      WHERE target_id = ${o.targetId}::uuid
    `);
  } else {
    await tx.execute(sql`
      UPDATE redirect_sync_state
      SET synced_revision = GREATEST(synced_revision, ${o.revision}),
          failed_attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE target_id = ${o.targetId}::uuid
    `);
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "redirects.sync_provider",
    input: { trigger, target: o.targetName, revision: o.revision },
    succeeded: o.status !== "failed",
    entityId: o.targetId,
    resultSummary: (o.status === "failed"
      ? `${o.targetName}: failed: ${o.error}`
      : `${o.targetName}: ${o.status}${o.redirectCount === null ? "" : `, ${o.redirectCount} redirects`}${o.location ? ` at ${o.location}` : ""}`
    ).slice(0, 500),
  });
}
