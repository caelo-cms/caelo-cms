// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's publisher of the gateway projection (issue #635).
 *
 * The public API gateway has no cms_admin login; it serves from what the
 * admin publishes into cms_public (`@caelo-cms/migrations/public-projection`
 * says what and how). This module runs that publisher inside the admin
 * process:
 *
 *   - {@link PublicProjectionPublisher.publishAll} after the plugin host
 *     booted — every section, so a release that adds a projected column or
 *     plugin converges as soon as the admin runs;
 *   - a drain of `public_projection_outbox` every {@link DRAIN_INTERVAL_MS},
 *     so any committed authoring write that changes published state reaches
 *     the gateway within seconds (the gateway then hears a NOTIFY on
 *     cms_public and drops its caches).
 *
 * Declarations come from the plugins this admin actually loaded (their
 * verified definitions), never from a manifest in the database.
 */

import {
  drainPublicProjection,
  type ProjectionDatabases,
  type PublishReport,
  publishPublicProjection,
  type VisitorProjectionDeclarations,
} from "@caelo-cms/migrations/public-projection";
import { loadedPlugins } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter } from "@caelo-cms/query-api";

/** How often the outbox is drained. */
export const DRAIN_INTERVAL_MS = 2_000;

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "public-projection",
};

/** The visitorProjection declarations of every plugin this host loaded. */
export function loadedVisitorProjections(): VisitorProjectionDeclarations {
  const out = new Map<string, Readonly<Record<string, ReadonlyArray<string>>>>();
  for (const p of loadedPlugins.all()) {
    const projection = p.definition.visitorProjection;
    if (projection && Object.keys(projection).length > 0) out.set(p.slug, projection);
  }
  return out;
}

/** The publisher's two transactions, both as the `system` actor. */
export function projectionDatabases(adapter: DatabaseAdapter): ProjectionDatabases {
  return {
    readAdmin: (fn) => adapter.withAdminTransaction(SYSTEM_CTX, fn),
    writePublic: (fn) => adapter.withPublicTransaction(SYSTEM_CTX, fn),
  };
}

/**
 * Publish every section once — including, with `comments: true`, the full
 * approved-comment set — and consume the outbox. For one-shot callers
 * (tooling, tests); the admin process uses {@link startPublicProjectionPublisher}.
 */
export function publishProjectionOnce(
  adapter: DatabaseAdapter,
  opts: {
    readonly declarations?: VisitorProjectionDeclarations;
    readonly comments?: boolean;
  } = {},
): Promise<PublishReport> {
  return publishPublicProjection(
    projectionDatabases(adapter),
    opts.declarations ?? loadedVisitorProjections(),
    { comments: opts.comments ?? true },
  );
}

/** Republish what the outbox marks stale, once (tooling, tests). */
export function drainProjectionOnce(
  adapter: DatabaseAdapter,
  declarations: VisitorProjectionDeclarations = loadedVisitorProjections(),
): Promise<PublishReport> {
  return drainPublicProjection(projectionDatabases(adapter), declarations);
}

export interface PublicProjectionPublisher {
  /** Publish every section (not the full comment set; the outbox carries comment changes). */
  publishAll(): Promise<PublishReport>;
  /** Republish whatever the outbox marks stale. */
  drain(): Promise<PublishReport>;
  stop(): void;
}

/**
 * Start draining the outbox on an interval. The caller runs
 * {@link PublicProjectionPublisher.publishAll} once its plugin host booted.
 */
export function startPublicProjectionPublisher(opts: {
  readonly adapter: DatabaseAdapter;
  readonly declarations?: () => VisitorProjectionDeclarations;
  readonly intervalMs?: number;
}): PublicProjectionPublisher {
  const dbs = projectionDatabases(opts.adapter);
  const declarations = opts.declarations ?? loadedVisitorProjections;
  let running: Promise<PublishReport> | null = null;
  // One publish at a time per process; the advisory lock serialises
  // processes (several admin instances, the migration job).
  const serial = (fn: () => Promise<PublishReport>): Promise<PublishReport> => {
    const next = (running ?? Promise.resolve(null)).then(fn, fn);
    running = next.finally(() => {
      if (running === next) running = null;
    }) as Promise<PublishReport>;
    return next;
  };
  const publisher: PublicProjectionPublisher = {
    publishAll: () =>
      serial(async () => {
        const report = await publishPublicProjection(dbs, declarations(), { comments: false });
        for (const slug of report.pendingPlugins) {
          console.error(
            `[public-projection] ${slug}: declared tables are not provisioned; its visitor operations will answer "not published" until the plugin loads`,
          );
        }
        return report;
      }),
    drain: () => serial(() => drainPublicProjection(dbs, declarations())),
    stop: () => clearInterval(timer),
  };
  const timer = setInterval(() => {
    publisher.drain().catch((e: unknown) => {
      console.error(
        `[public-projection] drain failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }, opts.intervalMs ?? DRAIN_INTERVAL_MS);
  return publisher;
}
