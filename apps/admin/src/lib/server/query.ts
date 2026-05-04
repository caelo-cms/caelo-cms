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

let _ctx: QueryContext | null = null;
let _verifyPromise: Promise<void> | null = null;

export function getQueryContext(): QueryContext {
  if (_ctx) return _ctx;

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

  _ctx = { adapter, registry, loginLimiter };
  return _ctx;
}

export function verifyQueryContextRoles(): Promise<void> {
  if (_verifyPromise) return _verifyPromise;
  _verifyPromise = getQueryContext().adapter.verifyRoles();
  return _verifyPromise;
}
