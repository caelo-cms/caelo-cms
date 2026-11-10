// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's publisher of the gateway projection (issues #635, #1329).
 *
 * The public API gateways have no cms_admin login; they serve from what the
 * admin publishes into cms_public and its staging twin cms_public_staging
 * (`@caelo-cms/migrations/public-projection` says what and how: immediate
 * sections from the current state, release sections from each
 * environment's frozen state). This module runs that publisher inside the
 * admin process:
 *
 *   - {@link PublicProjectionPublisher.publishAll} after the plugin host
 *     booted — every section, so a release that adds a projected column or
 *     plugin converges as soon as the admin runs;
 *   - a drain right after every write of this process that changed
 *     published state, before that write's op returns (registered with
 *     `DatabaseAdapter.setProjectionPublisher`): a security-relevant change
 *     is live on the public side when the admin call returns, even on a
 *     host that throttles CPU between requests;
 *   - {@link PublicProjectionPublisher.backstop} on every scheduler tick
 *     (#1140, scheduler/core-tasks.ts): writes from elsewhere (a migration,
 *     a process that died before its drain) and publishes that failed
 *     still converge within one tick. Until the boot publish succeeded,
 *     the backstop retries it instead of a plain drain.
 *
 * The gateway hears a NOTIFY on cms_public and drops its caches. On
 * request-billed CPU that NOTIFY waits until the gateway has CPU again, so
 * after a publish the admin also pings each gateway whose database it wrote
 * (`afterPublish`, gateway-refresh.ts).
 *
 * Declarations come from the plugins this admin actually loaded (their
 * verified definitions), never from a manifest in the database. They are
 * needed only to freeze a release state (a Stage, the bootstrap).
 */

import {
  drainPublicProjection,
  type FreezeCompleteness,
  type ProjectionDatabases,
  type PublishReport,
  publishPublicProjection,
  releaseMainLineForTests,
  type VisitorProjectionDeclarations,
} from "@caelo-cms/migrations/public-projection";
import { loadedPlugins } from "@caelo-cms/plugin-host";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { ADMIN_PUBLIC_STAGING_POOL_MAX } from "@caelo-cms/shared";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "public-projection",
};

/**
 * #1329 — the admin's adapter on the staging site's database
 * (cms_public_staging), as admin_role. Public-only, so nothing reaches
 * cms_admin through it, with the fixed pool the connection budget
 * reserves (`ADMIN_PUBLIC_STAGING_POOL_MAX`).
 */
export function stagingPublicAdapter(url: string): DatabaseAdapter {
  return new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: url,
    publicDatabase: "cms_public_staging",
    expectedRoles: { admin: null, public: ["admin_role"] },
    publicPoolMax: ADMIN_PUBLIC_STAGING_POOL_MAX,
  });
}

/**
 * The visitorProjection declaration of every plugin this host loaded —
 * `null` for one that declares none. A plugin not loaded here has no entry,
 * so this instance cannot freeze a release state (#1329,
 * `freezeRelease`).
 */
export function loadedVisitorProjections(): VisitorProjectionDeclarations {
  const out = new Map<string, Readonly<Record<string, ReadonlyArray<string>>> | null>();
  for (const p of loadedPlugins.all()) {
    const projection = p.definition.visitorProjection;
    out.set(p.slug, projection && Object.keys(projection).length > 0 ? projection : null);
  }
  return out;
}

/**
 * The publisher's transactions, all as the `system` actor: cms_admin and
 * cms_public through `adapter`, cms_public_staging through `stagingAdapter`
 * (the admin's public-only adapter on the staging database, #1329).
 */
export function projectionDatabases(
  adapter: DatabaseAdapter,
  stagingAdapter: DatabaseAdapter,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProjectionDatabases {
  return {
    readAdmin: (fn) => adapter.withAdminTransaction(SYSTEM_CTX, fn),
    writePublic: (target, fn) =>
      (target === "live" ? adapter : stagingAdapter).withPublicTransaction(SYSTEM_CTX, fn),
    // #1330 / #1331 — the staging gateway reads the gate key from its own
    // database; the admin is the one process that holds it.
    stagingGateSecret: env.CAELO_STAGING_GATE_SECRET || null,
  };
}

/**
 * Publish every section once — including, with `comments: true`, the full
 * approved-comment set — and consume the outbox. For one-shot callers
 * (tooling, tests); the admin process uses {@link createPublicProjectionPublisher}.
 */
export function publishProjectionOnce(
  adapter: DatabaseAdapter,
  stagingAdapter: DatabaseAdapter,
  opts: {
    readonly declarations?: VisitorProjectionDeclarations;
    readonly comments?: boolean;
  } = {},
): Promise<PublishReport> {
  return publishPublicProjection(
    projectionDatabases(adapter, stagingAdapter),
    opts.declarations ?? loadedVisitorProjections(),
    { comments: opts.comments ?? true },
  );
}

/**
 * Tests and test fixtures only (pinned by
 * scripts/no-automatic-production-deploy.test.ts): freeze the main line and
 * release it to both public databases at once, as a Stage plus Publish live
 * would, so a test sees plugin data it just wrote on the public side.
 */
export function releaseProjectionForTests(
  adapter: DatabaseAdapter,
  stagingAdapter: DatabaseAdapter,
  declarations: VisitorProjectionDeclarations = loadedVisitorProjections(),
  completeness: FreezeCompleteness = "required",
): Promise<PublishReport> {
  return releaseMainLineForTests(
    projectionDatabases(adapter, stagingAdapter),
    declarations,
    completeness,
  );
}

/** Republish what the outbox marks stale, once (tooling, tests). */
export function drainProjectionOnce(
  adapter: DatabaseAdapter,
  stagingAdapter: DatabaseAdapter,
): Promise<PublishReport> {
  return drainPublicProjection(projectionDatabases(adapter, stagingAdapter));
}

export interface PublicProjectionPublisher {
  /**
   * Publish every section (not the full comment set; the outbox carries
   * comment changes). Until one succeeds, the backstop retries it instead
   * of a plain drain, so a failed boot publish converges without a restart.
   */
  publishAll(): Promise<PublishReport>;
  /** Republish whatever the outbox marks stale. */
  drain(): Promise<PublishReport>;
  /** The scheduler tick's backstop: the full publish while one is due, else a drain. */
  backstop(): Promise<PublishReport>;
  /** Unregister the post-write drain (tests). */
  stop(): void;
}

/**
 * Create the process's publisher and register its post-write drain. The
 * caller runs {@link PublicProjectionPublisher.publishAll} once its plugin
 * host booted; the scheduler tick runs its backstop.
 *
 * Per process, publishes run one at a time, and drains coalesce: a drain
 * asked for while another drain is still WAITING to start joins that one —
 * it starts after the asker's commit, so it publishes the asker's change
 * too. Only a drain that already started (and may have read the outbox
 * before that commit) gets a new one queued behind it. So a burst of
 * writes costs at most two drains, not one per write; across processes
 * the advisory lock serialises (`withProjectionLock`).
 */
export function createPublicProjectionPublisher(opts: {
  readonly adapter: DatabaseAdapter;
  /** #1329 — the admin's adapter on cms_public_staging. */
  readonly stagingAdapter: DatabaseAdapter;
  readonly declarations?: () => VisitorProjectionDeclarations;
  /**
   * Run after every publish that succeeded, before the next one starts: the
   * refresh pings to the gateways whose database it wrote
   * (gateway-refresh.ts). Awaited, so a post-write drain returns only once
   * its pings are answered or recorded; it never fails the publish.
   */
  readonly afterPublish?: (report: PublishReport) => Promise<void>;
}): PublicProjectionPublisher {
  const dbs = projectionDatabases(opts.adapter, opts.stagingAdapter);
  const declarations = opts.declarations ?? loadedVisitorProjections;
  const afterPublish = async (report: PublishReport): Promise<PublishReport> => {
    if (opts.afterPublish) {
      await opts.afterPublish(report).catch((e: unknown) => {
        console.error(
          `[public-projection] after-publish step failed (the publish stands): ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
    return report;
  };
  let tail: Promise<unknown> = Promise.resolve();
  let waitingDrain: Promise<PublishReport> | null = null;
  let waitingFull: Promise<PublishReport> | null = null;
  let fullPublishDue = false;
  const enqueue = (fn: () => Promise<PublishReport>): Promise<PublishReport> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  const publisher: PublicProjectionPublisher = {
    publishAll: () => {
      // Same coalescing as drain: while the lock or the database is down the
      // scheduler tick's backstop retries a failed full publish every tick,
      // and each tick must join the one already queued instead of adding one
      // more to replay.
      if (waitingFull !== null) return waitingFull;
      const full = enqueue(async () => {
        waitingFull = null;
        let report: PublishReport;
        try {
          report = await publishPublicProjection(dbs, declarations(), { comments: false });
        } catch (e) {
          fullPublishDue = true;
          throw e;
        }
        fullPublishDue = false;
        for (const target of report.unreleased) {
          console.error(
            `[public-projection] ${target}: no frozen release state yet — an active plugin is not loaded here, so the plugin registry stays as published until an instance that runs every active plugin boots, or the next Stage`,
          );
        }
        return afterPublish(report);
      });
      waitingFull = full;
      return full;
    },
    drain: () => {
      if (waitingDrain !== null) return waitingDrain;
      const drain = enqueue(async () => {
        waitingDrain = null;
        return afterPublish(await drainPublicProjection(dbs));
      });
      waitingDrain = drain;
      return drain;
    },
    backstop: () => (fullPublishDue ? publisher.publishAll() : publisher.drain()),
    stop: () => {
      opts.adapter.setProjectionPublisher(null);
    },
  };
  // The drain is queued behind any publish already running, so it starts
  // after the caller's commit and therefore sees that commit's outbox rows.
  opts.adapter.setProjectionPublisher(() => publisher.drain());
  return publisher;
}
