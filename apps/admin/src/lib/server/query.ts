// SPDX-License-Identifier: MPL-2.0

import { resolve } from "node:path";
import {
  getMediaStorageFactory,
  LocalVolumeAdapter,
  type MediaStorageSetup,
  PostgresRateLimiter,
  registerAdminOps,
  setDeployBridge,
  setMediaStorage,
} from "@caelo-cms/admin-core";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { ADMIN_PUBLIC_STAGING_POOL_MAX, databaseUrlFromEnv } from "@caelo-cms/shared";

/**
 * Explicit, lazy query context. Server modules call `getQueryContext()` and
 * destructure the adapter / registry / limiters they need. Construction +
 * `verifyRoles()` happen on first call and are memoised.
 *
 * Replaces the earlier Proxy-based exports — `instanceof` and `typeof` checks
 * now behave normally, and a misconfigured deploy can be caught by
 * `healthcheck.ts` before any user request rather than at first interaction.
 */

interface QueryContext {
  readonly adapter: DatabaseAdapter;
  /**
   * #1329 — the staging site's public database (cms_public_staging), as
   * admin_role: a public-only adapter, so nothing can reach cms_admin
   * through it. Plugin tables are provisioned there on every load.
   */
  readonly stagingAdapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly loginLimiter: PostgresRateLimiter;
}

interface QueryContextSlot {
  ctx: QueryContext | null;
  verifyPromise: Promise<void> | null;
}

/**
 * The context singleton lives on `globalThis` rather than in a module-level
 * `let` so it survives Vite HMR. In dev, Vite re-evaluates this module (and
 * its importers) on every source change; a module-level singleton would reset
 * to `null` and `getQueryContext()` would build a *fresh* `DatabaseAdapter`
 * each reload, orphaning the previous adapter's two connection pools. Those
 * pools are never closed, so ~20 idle Postgres connections leaked per reload
 * until the database ran out of slots (errno 53300) — starving every other
 * client on the same Postgres, including the test runner. Anchoring on
 * `globalThis` makes each reload reuse the same adapter and pools.
 *
 * In production there is no HMR, so this is an ordinary process-wide singleton
 * — identical behaviour to the previous module-level field.
 */
const SLOT_KEY = Symbol.for("caelo.admin.queryContextSlot");
const globalSlots = globalThis as unknown as Record<symbol, QueryContextSlot | undefined>;
let existing = globalSlots[SLOT_KEY];
if (!existing) {
  existing = { ctx: null, verifyPromise: null };
  globalSlots[SLOT_KEY] = existing;
}
const slot: QueryContextSlot = existing;

/**
 * How this admin stores media, from env: the storage adapter
 * (`MEDIA_STORAGE_PROVIDER`, default `local`) and the local adapter's root
 * (`MEDIA_ROOT_DIR`, default `data/media` under the cwd). The static
 * generator inherits the same env, so it reads the same root.
 */
export function mediaStorageSetup(env: NodeJS.ProcessEnv = process.env): MediaStorageSetup {
  return {
    provider: env.CAELO_PROVIDER,
    storageProvider: env.MEDIA_STORAGE_PROVIDER ?? "local",
    rootDir: resolve(env.MEDIA_ROOT_DIR ?? "data/media"),
    ...(env.MEDIA_STORAGE_URL ? { mediaStorageUrl: env.MEDIA_STORAGE_URL } : {}),
  };
}

export function getQueryContext(): QueryContext {
  if (slot.ctx) return slot.ctx;

  const adminUrl = databaseUrlFromEnv(["ADMIN_DATABASE_URL"]);
  const publicUrl = databaseUrlFromEnv(["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"]);
  if (!adminUrl) throw new Error("ADMIN_DATABASE_URL is required");
  if (!publicUrl) {
    throw new Error("PUBLIC_ADMIN_DATABASE_URL or PUBLIC_DATABASE_URL is required");
  }

  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: adminUrl,
    publicDatabaseUrl: publicUrl,
  });
  // #1329 — required, no fallback: an admin without the staging database
  // would load plugins whose staging tables never exist.
  const stagingUrl = databaseUrlFromEnv(["PUBLIC_STAGING_ADMIN_DATABASE_URL"]);
  if (!stagingUrl) {
    throw new Error(
      "PUBLIC_STAGING_ADMIN_DATABASE_URL is required (admin_role on cms_public_staging, #1329). Cloud installs get it in the converge (`cms-provision upgrade`, or Install update in Settings → Updates); self-hosted: `cms-provision up`; local dev: add it to the root .env (.env.example) and run packages/migrations/src/bootstrap.sh + `bun run db:migrate`.",
    );
  }
  const stagingAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: stagingUrl,
    publicDatabase: "cms_public_staging",
    expectedRoles: { admin: null, public: ["admin_role"] },
    // Fixed, not from the budget env: pool-budget.ts reserves exactly this.
    publicPoolMax: ADMIN_PUBLIC_STAGING_POOL_MAX,
  });
  const registry = new OperationRegistry();
  registerAdminOps(registry);

  const loginLimiter = new PostgresRateLimiter(adapter, {
    windowMs: 5 * 60 * 1000,
    limit: 5,
  });

  // P6.2 — the deploy.trigger op spawns the static-generator CLI as a
  // subprocess and writes progress rows back via the same registry the
  // host uses. We hand it the registry+adapter pair here.
  setDeployBridge({ registry, adapter });

  // P7 — media storage. Local volume adapter with rootDir from env
  // by default; plugins / cloud adapters override via the
  // MEDIA_STORAGE_PROVIDER env + a registered factory (see
  // registerMediaStorageFactory in @caelo-cms/admin-core/media/storage).
  // On cloud installs the boot check (`init` in hooks.server.ts) has
  // already refused a local root that is not a persistent volume.
  const media = mediaStorageSetup();
  if (media.storageProvider === "local") {
    setMediaStorage(new LocalVolumeAdapter(media.rootDir), "local");
  } else {
    const factory = getMediaStorageFactory(media.storageProvider);
    if (!factory) {
      throw new Error(
        `MEDIA_STORAGE_PROVIDER=${media.storageProvider} but no factory registered. ` +
          `Use the default 'local' provider with a persistent volume at MEDIA_ROOT_DIR.`,
      );
    }
    setMediaStorage(factory(process.env), media.storageProvider);
  }

  slot.ctx = { adapter, stagingAdapter, registry, loginLimiter };
  return slot.ctx;
}

export function verifyQueryContextRoles(): Promise<void> {
  if (slot.verifyPromise) return slot.verifyPromise;
  const ctx = getQueryContext();
  slot.verifyPromise = Promise.all([
    ctx.adapter.verifyRoles(),
    ctx.stagingAdapter.verifyRoles(),
  ]).then(() => undefined);
  return slot.verifyPromise;
}
