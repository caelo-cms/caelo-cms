// SPDX-License-Identifier: MPL-2.0

/**
 * Deploy-pipeline health check. Exits 0 when the configured environment
 * resolves to a working admin/public connection pair, exits 1 otherwise.
 * Run before swapping a new release into production.
 *
 *   bun run packages/admin-core/src/healthcheck.ts
 */

import { DatabaseAdapter } from "@caelo-cms/query-api";

async function main(): Promise<number> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const publicUrl = process.env.PUBLIC_ADMIN_DATABASE_URL ?? process.env.PUBLIC_DATABASE_URL;
  if (!adminUrl) {
    console.error("ADMIN_DATABASE_URL is required");
    return 1;
  }
  if (!publicUrl) {
    console.error("PUBLIC_ADMIN_DATABASE_URL or PUBLIC_DATABASE_URL is required");
    return 1;
  }

  const adapter = new DatabaseAdapter({ adminDatabaseUrl: adminUrl, publicDatabaseUrl: publicUrl });
  try {
    await adapter.verifyRoles();
    console.log("healthcheck ok");
    return 0;
  } catch (e) {
    console.error("healthcheck failed:", e instanceof Error ? e.message : e);
    return 1;
  } finally {
    await adapter.close();
  }
}

const code = await main();
process.exit(code);
