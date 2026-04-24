// SPDX-License-Identifier: MPL-2.0

import { registerAdminOps } from "@caelo/admin-core";
import { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";

/**
 * Lazy-initialised adapter + registry. SvelteKit's build step imports every
 * `+page.server.ts` (and transitively `$lib/server/*`) under Bun to do route
 * discovery / SSR bundling — at that point `process.env.ADMIN_DATABASE_URL`
 * is not set. Throwing here crashes the build even though no real op runs.
 *
 * Deferring construction to first request also means the build-time analysis
 * only loads the module graph; the actual DB pools open at first request.
 */

let _adapter: DatabaseAdapter | null = null;
let _registry: OperationRegistry | null = null;

function ensure(): { adapter: DatabaseAdapter; registry: OperationRegistry } {
  if (_adapter && _registry) return { adapter: _adapter, registry: _registry };

  const adminUrl = process.env["ADMIN_DATABASE_URL"];
  const publicUrl =
    process.env["PUBLIC_ADMIN_DATABASE_URL"] ?? process.env["PUBLIC_DATABASE_URL"];
  if (!adminUrl) throw new Error("ADMIN_DATABASE_URL is required");
  if (!publicUrl) {
    throw new Error("PUBLIC_ADMIN_DATABASE_URL or PUBLIC_DATABASE_URL is required");
  }

  _adapter = new DatabaseAdapter({
    adminDatabaseUrl: adminUrl,
    publicDatabaseUrl: publicUrl,
  });
  _registry = new OperationRegistry();
  registerAdminOps(_registry);
  return { adapter: _adapter, registry: _registry };
}

/**
 * Proxy objects that look like eager exports but construct on first access.
 * Callers use `adapter` / `registry` as if they were already built; the first
 * property access triggers construction.
 */
export const adapter = new Proxy({} as DatabaseAdapter, {
  get(_t, p) {
    const a = ensure().adapter as unknown as Record<string | symbol, unknown>;
    const v = a[p];
    return typeof v === "function" ? v.bind(ensure().adapter) : v;
  },
});

export const registry = new Proxy({} as OperationRegistry, {
  get(_t, p) {
    const r = ensure().registry as unknown as Record<string | symbol, unknown>;
    const v = r[p];
    return typeof v === "function" ? v.bind(ensure().registry) : v;
  },
});
