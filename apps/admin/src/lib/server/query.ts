// SPDX-License-Identifier: MPL-2.0

import {
  getMediaStorageFactory,
  LocalVolumeAdapter,
  PostgresRateLimiter,
  registerAdminOps,
  setDeployBridge,
  setMediaStorage,
} from "@caelo-cms/admin-core";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";

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

export function getQueryContext(): QueryContext {
  if (slot.ctx) return slot.ctx;

  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const publicUrl = process.env.PUBLIC_ADMIN_DATABASE_URL ?? process.env.PUBLIC_DATABASE_URL;
  if (!adminUrl) throw new Error("ADMIN_DATABASE_URL is required");
  if (!publicUrl) {
    throw new Error("PUBLIC_ADMIN_DATABASE_URL or PUBLIC_DATABASE_URL is required");
  }

  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: adminUrl,
    publicDatabaseUrl: publicUrl,
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
  const providerName = process.env.MEDIA_STORAGE_PROVIDER ?? "local";
  if (providerName === "local") {
    const mediaRoot = process.env.MEDIA_ROOT_DIR ?? "data/media";
    setMediaStorage(new LocalVolumeAdapter(mediaRoot), "local");
  } else {
    const factory = getMediaStorageFactory(providerName);
    if (!factory) {
      throw new Error(
        `MEDIA_STORAGE_PROVIDER=${providerName} but no factory registered. ` +
          `Cloud adapters land in P15; until then, use the default 'local' provider.`,
      );
    }
    setMediaStorage(factory(process.env), providerName);
  }

  slot.ctx = { adapter, registry, loginLimiter };
  return slot.ctx;
}

export function verifyQueryContextRoles(): Promise<void> {
  if (slot.verifyPromise) return slot.verifyPromise;
  slot.verifyPromise = getQueryContext().adapter.verifyRoles();
  return slot.verifyPromise;
}
