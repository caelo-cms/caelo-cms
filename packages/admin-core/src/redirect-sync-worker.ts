// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — retries the production targets whose provider is behind the live
 * redirects.
 *
 * #1550 — a save no longer pushes anything (it is a pending change); the
 * releases that change the live redirects (Publish live, an Owner's
 * production build, Go live now, a rollback) push right after their commit.
 * A push that failed leaves its target behind
 * (`redirect_sync_state.wanted_revision > synced_revision`) with a
 * `next_attempt_at` that backs off from 1 minute to an hour;
 * {@link retryRedirectSync} retries every target that is due, and pushes a
 * live change nobody pushed yet (#1254: its row in `redirect_changes` is
 * still unfolded). It is two indexed reads while everything is in sync.
 *
 * The retry runs on the scheduler tick (#1140, scheduler/core-tasks.ts),
 * every tick. Neither it nor the plugin-data build ever applies a pending
 * change: they push the live table as it is.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { describeError } from "./ai/tools/_describe-error.js";
import { SYSTEM_ACTOR_ID } from "./audit.js";
import {
  markRedirectsBehind,
  type RedirectSyncOutcome,
  type RedirectSyncTrigger,
  redirectChangesPending,
} from "./deploy/redirect-sync.js";

interface RedirectSyncWorkerOpts {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}

let runs = 0;

/** Run `redirects.sync_provider` as the system actor; throws when the op itself fails. */
async function runSync(
  opts: RedirectSyncWorkerOpts,
  trigger: RedirectSyncTrigger,
  targetIds?: readonly string[],
): Promise<RedirectSyncOutcome[]> {
  const r = await execute(
    opts.registry,
    opts.adapter,
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `redirect-sync-${runs++}` },
    "redirects.sync_provider",
    { trigger, ...(targetIds ? { targetIds: [...targetIds] } : {}) },
  );
  if (!r.ok) throw new Error(`redirects.sync_provider failed: ${describeError(r.error)}`);
  return (r.value as { targets: RedirectSyncOutcome[] }).targets;
}

/**
 * One retry: push changes nobody pushed yet (their save's sync was skipped
 * or never ran) and retry the targets that are behind and whose backoff
 * has elapsed. Throws when the sync op itself fails.
 *
 * @returns how many targets are still not live after it
 */
export async function retryRedirectSync(opts: RedirectSyncWorkerOpts): Promise<number> {
  const { pending, due } = await opts.adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `redirect-sync-poll-${runs++}` },
    async (tx) => ({
      pending: await redirectChangesPending(tx),
      // #1550 — production only: staging is served by the staging gateway.
      due: (await tx.execute(sql`
        SELECT s.target_id::text AS target_id FROM redirect_sync_state s
        JOIN deploy_targets t ON t.id = s.target_id AND t.env = 'production'
        WHERE s.wanted_revision > s.synced_revision
          AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
      `)) as unknown as { target_id: string }[],
    }),
  );
  if (!pending && due.length === 0) return 0;
  // A pending change concerns every target (and restarts their backoff when
  // folded); otherwise only the due ones: another may still be backing off.
  const outcomes = await runSync(opts, "retry", pending ? undefined : due.map((d) => d.target_id));
  const failed = outcomes.filter((x) => x.status === "failed");
  for (const o of failed) {
    console.error("[redirect-sync-worker] the redirects are still not live", {
      target: o.targetName,
      error: o.error,
    });
  }
  return failed.length;
}

/** What {@link refreshStaleLiveRelease} found and did. */
export type LiveReleaseRefreshOutcome =
  /** The provider keeps no rewrite or headers in a release (everything but gcp-firebase). */
  | "not-applicable"
  /** The live release already has the current rewrite and fixed headers. */
  | "current"
  /** Nothing is live yet; the first Publish live writes the current config. */
  | "nothing-live"
  /** It was stale; a sync of the production targets released the current config. */
  | "refreshed";

/** What {@link refreshStaleLiveRelease} needs; injected so the decision is testable. */
export interface LiveReleaseRefreshDeps {
  /**
   * Whether the live release's `/api/**` rewrite names the gateway the
   * admin's env names now and its fixed headers are the current ones; null
   * when nothing is live.
   */
  readonly liveConfigIsCurrent: () => Promise<boolean | null>;
  /** Mark every production target behind and push it (`redirects.sync_provider`, `manual`). */
  readonly syncProduction: () => Promise<RedirectSyncOutcome[]>;
}

/**
 * The live Hosting release keeps the config it was created with until
 * something releases a new version. Two things in it belong to the install,
 * not to the build: (1) after a converge that moved the visitor gateway
 * (#1380; #1328 made the old gcp-firebase `gateway` service the
 * MCP-Auth-Proxy) its `/api/**` rewrite names the old service; (2) after a
 * release that fixes the fixed headers (nosniff, SVG CSP, favicon type —
 * firebase-version-headers.ts) it keeps the old ones, which before the
 * whole-path patterns sent nosniff only on `/` and no SVG CSP at all. Run
 * at the admin's boot: when either is stale, one redirect sync of the
 * production targets re-releases the served version with the current
 * config. The sync is the one writer of the served-version record, so the
 * plugin-data build and rollback keep finding the release
 * (`movedServedBuild`). Nothing is built or published: the files, redirects
 * and the build's own headers (page headers, cache, robots) stay as they
 * are.
 *
 * @throws when the sync ran and a production target failed (logged by the caller; the redirect-sync worker retries it).
 */
export async function refreshStaleLiveRelease(
  provider: string | undefined,
  deps: LiveReleaseRefreshDeps,
): Promise<LiveReleaseRefreshOutcome> {
  if (provider !== "gcp-firebase") return "not-applicable";
  const current = await deps.liveConfigIsCurrent();
  if (current === null) return "nothing-live";
  if (current) return "current";
  const outcomes = await deps.syncProduction();
  const failed = outcomes.filter((o) => o.env === "production" && o.status === "failed");
  if (failed.length > 0) {
    throw new Error(
      `the live site still has a stale /api/** rewrite or security headers: ${failed.map((o) => `${o.targetName}: ${o.error ?? "failed"}`).join("; ")}. The redirect sync retries it on the next scheduler tick; Settings → Redirects shows the error.`,
    );
  }
  return "refreshed";
}

/**
 * {@link refreshStaleLiveRelease} with the real Firebase read and sync,
 * for the admin's boot (apps/admin hooks.server.ts).
 */
export async function refreshStaleLiveReleaseAtBoot(
  opts: RedirectSyncWorkerOpts,
): Promise<LiveReleaseRefreshOutcome> {
  return refreshStaleLiveRelease(process.env.CAELO_PROVIDER, {
    liveConfigIsCurrent: async () =>
      (await import("./deploy/static-publisher-firebase.js")).liveReleaseConfigIsCurrent(),
    syncProduction: async () => {
      const ids = await opts.adapter.withAdminTransaction(
        {
          actorId: SYSTEM_ACTOR_ID,
          actorKind: "system",
          requestId: `live-release-refresh-${runs++}`,
        },
        async (tx) => {
          const rows = (await tx.execute(sql`
            SELECT id::text AS id FROM deploy_targets WHERE env = 'production' ORDER BY id
          `)) as unknown as { id: string }[];
          const targetIds = rows.map((r) => r.id);
          await markRedirectsBehind(tx, targetIds);
          return targetIds;
        },
      );
      return ids.length === 0 ? [] : runSync(opts, "manual", ids);
    },
  });
}

/**
 * #1331 — at the admin's boot on gcp-firebase: delete the preview channels
 * an older release staged to (public by URL, a second path to staged pages).
 * Logs the ones that are still there; every Stage tries again.
 */
export async function retireLegacyStagingPreviewsAtBoot(): Promise<void> {
  if (process.env.CAELO_PROVIDER !== "gcp-firebase") return;
  const { retireLegacyPreviewChannels } = await import("./deploy/static-publisher-firebase.js");
  for (const left of await retireLegacyPreviewChannels()) {
    console.error(
      "[bootstrap.staging-previews] an old preview channel could not be deleted yet",
      left,
    );
  }
}
