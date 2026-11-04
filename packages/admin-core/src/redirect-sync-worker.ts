// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — runs the redirect sync after redirects writes and retries the
 * targets whose provider is behind.
 *
 * {@link registerRedirectSyncRunner} registers the post-commit runner every
 * redirects write uses (deploy/redirect-sync.ts `setRedirectSyncRunner`), so
 * a save pushes the table to the hosting provider before its request
 * answers. A push that failed leaves its target behind
 * (`redirect_sync_state.wanted_revision > synced_revision`) with a
 * `next_attempt_at` that backs off from 1 minute to an hour;
 * {@link retryRedirectSync} retries every target that is due, and pushes a
 * change whose own save could not (#1254: its row in `redirect_changes` is
 * still unfolded). It is two indexed reads while everything is in sync.
 *
 * The runner is registered once per admin process from
 * apps/admin/src/hooks.server.ts; the retry runs on the scheduler tick
 * (#1140, scheduler/core-tasks.ts), every tick.
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
  setRedirectSyncRunner,
} from "./deploy/redirect-sync.js";

interface RedirectSyncWorkerOpts {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}

let registered = false;
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
 * #1254 — saves coalesce: at most one save sync runs per process and one
 * waits behind it. A save that commits while a sync runs joins the waiting
 * one, which starts after the running one ended — so it pushes every change
 * committed before it started, and each caller is answered by a push that
 * saw its own change. Without this, a save during another save's push would
 * find the lease taken by its sibling and answer "not live yet".
 */
let saveRunning: Promise<RedirectSyncOutcome[]> | null = null;
let saveQueued: Promise<RedirectSyncOutcome[]> | null = null;

function coalescedSave(opts: RedirectSyncWorkerOpts): Promise<RedirectSyncOutcome[]> {
  if (saveRunning === null) {
    saveRunning = runSync(opts, "save").finally(() => {
      saveRunning = null;
    });
    return saveRunning;
  }
  saveQueued ??= saveRunning
    .catch(() => undefined)
    .then(() => {
      saveQueued = null;
      return coalescedSave(opts);
    });
  return saveQueued;
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
      due: (await tx.execute(sql`
        SELECT target_id::text AS target_id FROM redirect_sync_state
        WHERE wanted_revision > synced_revision
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
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

/**
 * Register the post-commit runner every redirects write uses. Idempotent —
 * a second call is a no-op.
 */
export function registerRedirectSyncRunner(opts: RedirectSyncWorkerOpts): void {
  if (registered) return;
  registered = true;
  setRedirectSyncRunner((trigger) =>
    trigger === "save" ? coalescedSave(opts) : runSync(opts, trigger),
  );
}

/** Test-only — unregister the runner. */
export function unregisterRedirectSyncRunner(): void {
  registered = false;
  setRedirectSyncRunner(null);
}

/** What {@link repointStaleGatewayRewrite} found and did. */
export type GatewayRepointOutcome =
  /** The provider has no `/api/**` rewrite of its own (everything but gcp-firebase). */
  | "not-applicable"
  /** The live release already sends `/api/**` to the current gateway. */
  | "current"
  /** Nothing is live yet; the first Publish live writes the current rewrite. */
  | "nothing-live"
  /** It named an older gateway; a sync of the production targets released the current one. */
  | "repointed";

/** What {@link repointStaleGatewayRewrite} needs; injected so the decision is testable. */
export interface GatewayRepointDeps {
  /**
   * Whether the live release's `/api/**` rewrite names the gateway the
   * admin's env names now; null when nothing is live.
   */
  readonly liveRewriteIsCurrent: () => Promise<boolean | null>;
  /** Mark every production target behind and push it (`redirects.sync_provider`, `manual`). */
  readonly syncProduction: () => Promise<RedirectSyncOutcome[]>;
}

/**
 * #1380 — after a converge that moved the visitor gateway (#1328 made the
 * old gcp-firebase `gateway` service the MCP-Auth-Proxy), the live Hosting
 * release keeps an `/api/**` rewrite to the old service until something
 * releases a new version. Run at the admin's boot: when the live rewrite is
 * stale, one redirect sync of the production targets re-releases the served
 * version with the current rewrite. The sync is the one writer of the
 * served-version record, so the plugin-data build and rollback keep finding
 * the release (`movedServedBuild`). Nothing is built or published: the
 * files, redirects and headers of the live release stay as they are.
 *
 * @throws when the sync ran and a production target failed (logged by the caller; the redirect-sync worker retries it).
 */
export async function repointStaleGatewayRewrite(
  provider: string | undefined,
  deps: GatewayRepointDeps,
): Promise<GatewayRepointOutcome> {
  if (provider !== "gcp-firebase") return "not-applicable";
  const current = await deps.liveRewriteIsCurrent();
  if (current === null) return "nothing-live";
  if (current) return "current";
  const outcomes = await deps.syncProduction();
  const failed = outcomes.filter((o) => o.env === "production" && o.status === "failed");
  if (failed.length > 0) {
    throw new Error(
      `the live site's /api/** still reaches the previous gateway: ${failed.map((o) => `${o.targetName}: ${o.error ?? "failed"}`).join("; ")}. The redirect sync retries it on the next scheduler tick; Settings → Redirects shows the error.`,
    );
  }
  return "repointed";
}

/**
 * {@link repointStaleGatewayRewrite} with the real Firebase read and sync,
 * for the admin's boot (apps/admin hooks.server.ts).
 */
export async function repointStaleGatewayRewriteAtBoot(
  opts: RedirectSyncWorkerOpts,
): Promise<GatewayRepointOutcome> {
  return repointStaleGatewayRewrite(process.env.CAELO_PROVIDER, {
    liveRewriteIsCurrent: async () =>
      (await import("./deploy/static-publisher-firebase.js")).liveGatewayRewriteIsCurrent(),
    syncProduction: async () => {
      const ids = await opts.adapter.withAdminTransaction(
        { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `gateway-repoint-${runs++}` },
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
