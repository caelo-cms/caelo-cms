// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — the live redirects reach the hosting provider without a build.
 *
 * Redirects are not page content: they are answered by the hosting
 * provider in front of the static files (Firebase Hosting config, the GCP
 * URL map, the Caddy snippet). So a change of the LIVE redirects (the
 * `redirects` table) is pushed to the provider of every production target
 * right after it commits, without a build.
 *
 * #1550 — and only a release changes the live redirects: Publish live, an
 * Owner's production build, Go live now and a rollback (`redirects/
 * release.ts`). A save is a pending change (Draft or Staged) and pushes
 * nothing; staging serves the staging view from its own gateway
 * (cms_public_staging), so only production targets are synced here.
 *
 * #1254 — and nothing of the sync sits on the write path:
 *
 *  1. A write that changes a `redirects` row leaves one insert-only row in
 *     `redirect_changes` (row triggers, migration 0457), keyed by its own
 *     transaction id. No site-wide row is written or locked in the
 *     writer's transaction, so parallel writes never queue on it.
 *  2. After the commit, the release runs `redirects.sync_provider` (Go live
 *     now unrestricted, a Publish live, production build or rollback for its
 *     target), which calls {@link syncRedirects}; the retry worker pushes
 *     what is left on the scheduler tick. A sync is three steps, none of
 *     which holds a transaction across the network:
 *       - prepare (one short transaction): fold every visible change row
 *         into `redirect_sync_state.wanted_revision` of every target and
 *         delete it; CLAIM the live-release lease (a lease row with an
 *         expiry, not a lock); read the revision, then the table and the
 *         build each target serves; commit;
 *       - push (no transaction, no row lock): `StaticPublisher.syncRedirects`
 *         per target against the files of the build it serves NOW — the
 *         live page still wins, a draft page's path is not live yet;
 *       - record (one short transaction): the attempt (`redirect_syncs`,
 *         audit), `synced_revision = GREATEST(synced, read revision)` — a
 *         newer change folded meanwhile keeps the target behind — and
 *         release the leases.
 *     A sync that found more to do afterwards (a change committed during
 *     its push, a target left behind by a publish) runs another round.
 *  3. A failed attempt leaves the target behind (wanted > synced), is shown
 *     in Settings → Redirects and the notification bell, is named in the
 *     redirect tools' results ("NOT live yet" + the error), and is retried
 *     with backoff by the redirect-sync worker. Never silent. It does not
 *     turn the release itself into an error: the live state is recorded,
 *     and the push follows it.
 *
 * Every change of the build a production target serves runs the same sync
 * for that target once the files are live — Publish live, an Owner's
 * production build, the plugin-data build and a rollback, each after its
 * own transaction committed (#1211, #1225): the build they ship carries the
 * table as it was at its build time, and the provider must end up with the
 * live table as it is now.
 *
 * Revisions make "is the provider current?" exact without comparing tables:
 * the prepare step reads the revision BEFORE the rows, so a sync can only
 * record a revision whose rows it has seen; a change it did not see is a
 * change row it did not fold, which leaves the target behind.
 */

import { randomUUID } from "node:crypto";
import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import type { ExecutionContext, RedirectTableRow } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import {
  claimLiveReleaseForSync,
  releaseLiveReleaseForSync,
  renewLiveReleaseForSync,
} from "./live-release-lock.js";
import { resolveOutputRoot } from "./output-root.js";
import { loadStaticPublisher, type StaticPublisher } from "./static-publisher.js";

/**
 * Why a sync ran. Before #1550 every redirects write pushed the table
 * (`save`, kept only in the history of `redirect_syncs`); now the releases,
 * Go live now (`go_live`), a retry and the operator's "Try again" do.
 */
export type RedirectSyncTrigger = "build" | "publish" | "rollback" | "retry" | "manual" | "go_live";

/** Triggers that changed the build a target serves (see {@link syncRedirects}). */
const SERVED_BUILD_CHANGED: ReadonlySet<RedirectSyncTrigger> = new Set([
  "build",
  "publish",
  "rollback",
]);

/**
 * Triggers that push every target they claim, behind or not: a new served
 * build (it carries an old table) and the operator's "Try again". Go live
 * now and a retry push only the targets that are behind.
 */
const PUSH_ALL: ReadonlySet<RedirectSyncTrigger> = new Set([...SERVED_BUILD_CHANGED, "manual"]);

/**
 * What one sync attempt did for one target. `nothing-live`: the target
 * serves no build yet, so there is nothing to put redirects in front of —
 * they go out with its first publish.
 */
export type RedirectSyncStatus = "applied" | "unchanged" | "not-served" | "nothing-live" | "failed";

/** One target's result of {@link syncRedirects}. */
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

/**
 * The deploy targets whose provider serves the live redirects. #1550 —
 * staging is served by the staging gateway on every provider (#1330),
 * which answers the staging view from cms_public_staging itself.
 */
const SYNC_ENVS = sql`('production')`;

/** History rows kept per target. */
const HISTORY_PER_TARGET = 50;

/** Longest wait between two retries of a failing target. */
const MAX_BACKOFF_MINUTES = 60;

/**
 * How long a sync's lease claim lives without renewal. A push takes
 * seconds; the claim is renewed every {@link SYNC_LEASE_RENEW_MS} while it
 * runs, and lapses on the database clock should the instance die.
 */
const SYNC_LEASE_TTL_MS = 2 * 60_000;
const SYNC_LEASE_RENEW_MS = 30_000;

/**
 * Rounds one sync runs at most when more became due during its push. Each
 * round needs new work (a change committed meanwhile); what is left after
 * the last one is due for the worker's next poll.
 */
const MAX_ROUNDS = 5;

/**
 * #1211 — mark `targetIds` as behind in the caller's transaction: the build
 * they serve changed and carries the redirects of its own build time. The
 * caller pushes the table after its commit (`redirects.sync_provider`), so
 * no provider I/O runs inside its transaction; should that push fail or
 * never run, the target stays behind and the worker retries it. Called by
 * the step that records a Publish live, production build, plugin-data
 * build, rollback or Go live now — never by a content write.
 */
export async function markRedirectsBehind(
  tx: TransactionRunner,
  targetIds: readonly string[],
): Promise<void> {
  if (targetIds.length === 0) return;
  const ids = uuidArray(targetIds);
  await tx.execute(sql`
    INSERT INTO redirect_sync_state (target_id, wanted_revision)
    SELECT id, 1 FROM deploy_targets WHERE env IN ${SYNC_ENVS} AND id = ANY(${ids}) ORDER BY id
    ON CONFLICT (target_id) DO UPDATE
      SET wanted_revision = redirect_sync_state.wanted_revision + 1, updated_at = now()
  `);
}

/**
 * Fold every committed change row this transaction sees into the targets'
 * wanted revision. A change folds once: its row is deleted here, and a row
 * of a transaction still running is invisible, stays and is folded by the
 * next sync. A new change also restarts a failing target's backoff, so it
 * is pushed now instead of at the next retry.
 *
 * @returns whether anything was folded.
 */
async function foldChanges(tx: TransactionRunner): Promise<boolean> {
  const folded = (await tx.execute(sql`
    WITH gone AS (DELETE FROM redirect_changes RETURNING 1)
    SELECT count(*)::int AS n FROM gone
  `)) as unknown as { n: number }[];
  if ((folded[0]?.n ?? 0) === 0) return false;
  await tx.execute(sql`
    UPDATE redirect_sync_state
    SET wanted_revision = wanted_revision + 1, failed_attempts = 0, next_attempt_at = NULL,
        updated_at = now()
    WHERE target_id IN (SELECT id FROM deploy_targets WHERE env IN ${SYNC_ENVS})
  `);
  return true;
}

/** Whether a change is waiting to be folded (the worker's and status' view). */
export async function redirectChangesPending(tx: TransactionRunner): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM redirect_changes) AS pending
  `)) as unknown as { pending: boolean }[];
  return rows[0]?.pending === true;
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

/** One target a round pushes, with what the prepare step read for it. */
interface PlannedTarget {
  readonly row: TargetRow;
  readonly revision: number;
  /** Null: the target serves no build yet (`nothing-live`). */
  readonly servedRunId: string | null;
}

/** What a round's prepare step committed to push. */
interface RoundPlan {
  readonly claimed: ReadonlyArray<"production">;
  readonly targets: readonly PlannedTarget[];
  readonly table: readonly RedirectTableRow[];
}

/** One target's push result, recorded by the round's last step. */
interface PushResult {
  readonly planned: PlannedTarget;
  readonly outcome: RedirectSyncOutcome;
  readonly counts: { gone: number; shadowed: number } | null;
  readonly movedServedBuild?: { readonly from: string; readonly to: string };
}

/** Arguments of {@link syncRedirects}. */
export interface SyncRedirectsArgs {
  readonly trigger: RedirectSyncTrigger;
  /** Limit to these deploy target ids (a publish syncs its own target). */
  readonly targetIds?: readonly string[];
  /** Where relative out_dirs resolve (defaults like deploy ops do). */
  readonly outputRoot?: string;
  /** Test seam; the provider's publisher otherwise. */
  readonly publisher?: StaticPublisher;
}

/**
 * Put the redirects table live on the given targets (default: every
 * production target), recording each attempt. Never throws for
 * a provider failure — that is a `failed` outcome, recorded and scheduled
 * for retry.
 *
 * `tx` must hold NO transaction: it is the runner of a detached op
 * (`transaction: "none"`), whose `tx.transaction(fn)` opens a short
 * transaction of its own per step. The provider calls run between those
 * steps with no transaction open and no row locked; the publish lease of
 * each synced environment is claimed for them instead (see the module
 * header). A target whose lease someone else holds is skipped and stays
 * behind: that holder — a Publish live, a Stage, a rollback or another sync
 * — syncs it when it finishes, and the worker retries.
 *
 * @returns one outcome per pushed target (the last round's, per target);
 *   for a manual retry of given targets, only theirs — also when the retry
 *   widened to every target (see {@link widenManualRetry}).
 */
export async function syncRedirects(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  requested: SyncRedirectsArgs,
): Promise<RedirectSyncOutcome[]> {
  const args = await widenManualRetry(tx, requested);
  const syncId = randomUUID();
  const outputRoot = resolveOutputRoot(args.outputRoot);
  let publisher = args.publisher ?? null;
  const outcomes = new Map<string, RedirectSyncOutcome>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const plan = await tx.transaction((t) => prepareRound(t, args, syncId, round === 0));
    if (plan.claimed.length === 0) break;
    let results: PushResult[] = [];
    try {
      if (plan.targets.length > 0) {
        publisher ??= await loadStaticPublisher(process.env.CAELO_PROVIDER);
        const pub = publisher;
        results = await withRenewedClaims(tx, plan.claimed, syncId, async () => {
          const out: PushResult[] = [];
          for (const p of plan.targets) out.push(await pushTarget(p, plan.table, pub, outputRoot));
          return out;
        });
      }
    } finally {
      // Record and release in one short transaction, also when a push threw
      // past `pushTarget` (a bug): the lease must not wait for its expiry.
      await tx.transaction(async (t) => {
        for (const r of results) await record(t, ctx, args.trigger, r);
        await releaseClaims(t, plan.claimed, syncId);
      });
    }
    for (const r of results) outcomes.set(r.outcome.targetId, r.outcome);
    // A sync limited to its targets (a publish) folds nothing and is done;
    // an unrestricted one takes what became due during its push.
    if (args.targetIds !== undefined) break;
    if (!(await tx.transaction((t) => moreDue(t)))) break;
  }
  // The operator asked about these targets: another target the widened
  // retry pushed along records its own result on its own row, and its
  // failure (a target with no build to serve) must not answer this retry.
  // Lower-cased like the `id::text` the outcomes carry: the database
  // matched an upper-case spelling of the same uuid.
  const asked =
    requested.targetIds === undefined
      ? null
      : new Set(requested.targetIds.map((id) => id.toLowerCase()));
  // Production first: it is what visitors see.
  return [...outcomes.values()]
    .filter((o) => asked === null || asked.has(o.targetId))
    .sort((a, b) => Number(b.env === "production") - Number(a.env === "production"));
}

/**
 * An operator's "Try again now" on one target while a saved change is not
 * folded yet: the target cannot get in sync without that change, and only
 * an unrestricted sync folds it (changes are site-wide). Folding restarts
 * every target's backoff, so the retry pushes every target the change
 * concerns — none of them is backing off any more. Without this the retry
 * pushed the old table and left the target "Going live…" until the next
 * scheduler tick folded the change (#1157, #1140). A publish's targeted
 * sync stays targeted: it never takes the other targets' push. The widened
 * sync still answers only for the targets the operator retried
 * ({@link syncRedirects}).
 */
async function widenManualRetry(
  tx: TransactionRunner,
  args: SyncRedirectsArgs,
): Promise<SyncRedirectsArgs> {
  if (args.trigger !== "manual" || args.targetIds === undefined) return args;
  if (!(await tx.transaction((t) => redirectChangesPending(t)))) return args;
  return {
    trigger: args.trigger,
    ...(args.outputRoot !== undefined ? { outputRoot: args.outputRoot } : {}),
    ...(args.publisher !== undefined ? { publisher: args.publisher } : {}),
  };
}

/**
 * The prepare step of one round (see the module header), in its own short
 * transaction. Claims nothing when there is nothing to push, so a sync
 * with nothing due leaves the leases alone.
 */
async function prepareRound(
  tx: TransactionRunner,
  args: SyncRedirectsArgs,
  syncId: string,
  firstRound: boolean,
): Promise<RoundPlan> {
  const only = (column: string) =>
    args.targetIds === undefined
      ? sql``
      : args.targetIds.length === 0
        ? sql`AND false`
        : sql`AND ${sql.raw(column)} = ANY(${uuidArray(args.targetIds)})`;
  await tx.execute(sql`
    INSERT INTO redirect_sync_state (target_id)
    SELECT id FROM deploy_targets WHERE env IN ${SYNC_ENVS} ORDER BY id
    ON CONFLICT (target_id) DO NOTHING
  `);
  // Changes are site-wide: only an unrestricted sync folds them, so a
  // publish of one target never takes the other targets' push.
  if (args.targetIds === undefined) await foldChanges(tx);
  const pushAll = firstRound && PUSH_ALL.has(args.trigger);
  // A save or a retry pushes the targets that are behind and not backing
  // off (a new change restarts the backoff, foldChanges).
  const behindAndDue = sql`AND s.wanted_revision > s.synced_revision
    AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())`;
  // Which environments have something to push, before claiming anything.
  const wanted = (await tx.execute(sql`
    SELECT DISTINCT t.env FROM deploy_targets t JOIN redirect_sync_state s ON s.target_id = t.id
    WHERE t.env IN ${SYNC_ENVS} ${only("t.id")}
      ${pushAll ? sql`` : behindAndDue}
  `)) as unknown as { env: "staging" | "production" }[];
  if (wanted.length === 0) return { claimed: [], targets: [], table: [] };

  // Never waits: a held live-release lease (a Publish live, a rollback, a
  // plugin-data build, another sync) skips the push; its holder syncs.
  const claimed: "production"[] = [];
  const claim = { syncId, ttlMs: SYNC_LEASE_TTL_MS };
  if (await claimLiveReleaseForSync(tx, claim)) claimed.push("production");
  if (claimed.length === 0) return { claimed, targets: [], table: [] };
  const claimedEnvs = textArray(claimed);

  // A new served build carries the redirects of its own build time, so the
  // provider may now serve an older table: the target is behind until this
  // sync succeeds, and a failure here is retried like a failed save.
  if (firstRound && SERVED_BUILD_CHANGED.has(args.trigger)) {
    await tx.execute(sql`
      UPDATE redirect_sync_state SET wanted_revision = wanted_revision + 1, updated_at = now()
      WHERE target_id IN (SELECT id FROM deploy_targets WHERE env = ANY(${claimedEnvs}) ${only("id")})
    `);
  }
  // The revision first, then the rows (see the module comment). No row
  // lock: the claimed lease orders every sync of these environments.
  const rows = (await tx.execute(sql`
    SELECT t.id::text AS id, t.name, t.env, t.out_dir, t.base_url, t.robots_default,
           t.page_url_style, s.wanted_revision, s.failed_attempts
    FROM deploy_targets t JOIN redirect_sync_state s ON s.target_id = t.id
    WHERE t.env = ANY(${claimedEnvs}) ${only("t.id")}
      ${pushAll ? sql`` : behindAndDue}
    ORDER BY (t.env = 'production') DESC, t.id
  `)) as unknown as TargetRow[];
  const tableRows = (await tx.execute(sql`
    SELECT from_path, to_path, status_code FROM redirects ORDER BY from_path
  `)) as unknown as { from_path: string; to_path: string; status_code: number }[];
  const targets: PlannedTarget[] = [];
  for (const row of rows) {
    targets.push({
      row,
      revision: Number(row.wanted_revision),
      servedRunId: await servedRun(tx, row),
    });
  }
  return {
    claimed,
    targets,
    table: tableRows.map((r) => ({
      fromPath: r.from_path,
      toPath: r.to_path,
      statusCode: r.status_code,
    })),
  };
}

/** Run `work` (the pushes) while renewing the sync's lease claims. */
async function withRenewedClaims<T>(
  tx: TransactionRunner,
  claimed: ReadonlyArray<"production">,
  syncId: string,
  work: () => Promise<T>,
): Promise<T> {
  const claim = { syncId, ttlMs: SYNC_LEASE_TTL_MS };
  const renew = () =>
    tx
      .transaction(async (t) => {
        if (claimed.includes("production")) await renewLiveReleaseForSync(t, claim);
      })
      .catch((e: unknown) => {
        // A missed renewal is not fatal while the TTL still covers the push;
        // should it lapse, the holder after it re-syncs the table anyway.
        console.error("[redirect-sync] lease renewal failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
  const timer = setInterval(() => void renew(), SYNC_LEASE_RENEW_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function releaseClaims(
  tx: TransactionRunner,
  claimed: ReadonlyArray<"production">,
  syncId: string,
): Promise<void> {
  if (claimed.includes("production")) await releaseLiveReleaseForSync(tx, syncId);
}

/**
 * After a round: is there more to push now — a change committed during the
 * push, or a target left behind (a publish marked it while this sync held
 * its lease) that is not backing off?
 */
async function moreDue(tx: TransactionRunner): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM redirect_changes)
        OR EXISTS (
          SELECT 1 FROM redirect_sync_state s JOIN deploy_targets t ON t.id = s.target_id
          WHERE t.env IN ${SYNC_ENVS} AND s.wanted_revision > s.synced_revision
            AND s.next_attempt_at IS NULL
        ) AS due
  `)) as unknown as { due: boolean }[];
  return rows[0]?.due === true;
}

/** One target's provider push — no transaction is open here. */
async function pushTarget(
  p: PlannedTarget,
  table: readonly RedirectTableRow[],
  publisher: StaticPublisher,
  outputRoot: string,
): Promise<PushResult> {
  const t = p.row;
  const base = { targetId: t.id, targetName: t.name, env: t.env, revision: p.revision };
  if (p.servedRunId === null) {
    return {
      planned: p,
      counts: null,
      outcome: {
        ...base,
        status: "nothing-live",
        redirectCount: null,
        unservedTargets: [],
        location: null,
        error: null,
      },
    };
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
  try {
    const result = await publisher.syncRedirects({
      target,
      rows: table,
      servedRunId: p.servedRunId,
      outputRoot,
    });
    return {
      planned: p,
      counts: { gone: result.goneCount, shadowed: result.shadowedCount },
      ...(result.movedServedBuild !== undefined
        ? { movedServedBuild: result.movedServedBuild }
        : {}),
      outcome: {
        ...base,
        status: result.outcome,
        redirectCount: result.redirectCount,
        unservedTargets: result.unservedTargets,
        location: result.location,
        error: null,
      },
    };
  } catch (e) {
    return {
      planned: p,
      counts: null,
      outcome: {
        ...base,
        status: "failed",
        redirectCount: null,
        unservedTargets: [],
        location: null,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 4000),
      },
    };
  }
}

/**
 * The deploy run whose build production target `t` serves: its last
 * released succeeded run with a build (Publish live, rollback). Null when
 * nothing was ever published there.
 */
async function servedRun(tx: TransactionRunner, t: TargetRow): Promise<string | null> {
  // Release order, not start order: every publish and rollback marks its
  // run finished while it holds the target's publish lease, so the newest
  // finished_at is the build released last.
  const rows = (await tx.execute(sql`
    SELECT id::text AS id FROM deploy_runs
    WHERE target_id = ${t.id}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
    ORDER BY finished_at DESC NULLS LAST, started_at DESC LIMIT 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * Record one push (history, state, audit) — the compare-and-set step.
 * Success: `synced_revision` moves up to the revision the push READ, never
 * further, so a change folded meanwhile keeps the target behind. Failure:
 * the backoff starts only while no newer change is waiting (a newer one is
 * pushed by the next round instead of an hour later).
 */
async function record(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  trigger: RedirectSyncTrigger,
  r: PushResult,
): Promise<void> {
  const o = r.outcome;
  const servedRunId = r.planned.servedRunId;
  await tx.execute(sql`
    INSERT INTO redirect_syncs
      (target_id, trigger, status, revision, served_run_id, redirect_count, gone_count,
       shadowed_count, unserved_targets, location, error_message, actor_id, request_id)
    VALUES (${o.targetId}::uuid, ${trigger}, ${o.status}, ${o.revision},
            ${servedRunId}::uuid, ${o.redirectCount}, ${r.counts?.gone ?? null},
            ${r.counts?.shadowed ?? null}, ${jsonbParam(o.unservedTargets)},
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
          next_attempt_at = CASE WHEN wanted_revision > ${o.revision} THEN NULL ELSE
            clock_timestamp()
              + make_interval(mins => LEAST(power(2, LEAST(failed_attempts, 10))::int, ${MAX_BACKOFF_MINUTES}))
          END,
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
  if (r.movedServedBuild !== undefined) {
    // The served build now lives at a new provider location (a new Firebase
    // Hosting version with the same files). A rollback reads a run's
    // recorded location, which release retention may delete once
    // redirect-only releases pile up — so the run that recorded the copied
    // version follows it. Matched by that version, not by which run looks
    // newest, so no other run's build can be pointed at.
    await tx.execute(sql`
      UPDATE deploy_runs
      SET publish_summary = jsonb_set(publish_summary, '{location}', to_jsonb(${r.movedServedBuild.to}::text))
      WHERE target_id = ${o.targetId}::uuid
        AND publish_summary->>'location' = ${r.movedServedBuild.from}
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
