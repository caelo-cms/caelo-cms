// SPDX-License-Identifier: MPL-2.0

import { PostgresRateLimiter, registerAdminOps } from "@caelo/admin-core";
import { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";

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

  const adminUrl = process.env["ADMIN_DATABASE_URL"];
  const publicUrl = process.env["PUBLIC_ADMIN_DATABASE_URL"] ?? process.env["PUBLIC_DATABASE_URL"];
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

  _ctx = { adapter, registry, loginLimiter };
  return _ctx;
}

export function verifyQueryContextRoles(): Promise<void> {
  if (_verifyPromise) return _verifyPromise;
  _verifyPromise = getQueryContext().adapter.verifyRoles();
  return _verifyPromise;
}
