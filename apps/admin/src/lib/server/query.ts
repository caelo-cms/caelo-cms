// SPDX-License-Identifier: MPL-2.0

import { registerAdminOps } from "@caelo/admin-core";
import { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"] ?? process.env["PUBLIC_DATABASE_URL"];
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_ADMIN_DATABASE_URL or PUBLIC_DATABASE_URL is required");

/**
 * Process-wide adapter + registry. One instance per admin server. Created on
 * first module import; {@link DatabaseAdapter.verifyRoles} is invoked lazily
 * on the first operation so an incorrect env config fails-fast at that point
 * rather than at import time (which would prevent even showing an error page).
 */
export const adapter = new DatabaseAdapter({
  adminDatabaseUrl: ADMIN_URL,
  publicDatabaseUrl: PUBLIC_URL,
});

export const registry = new OperationRegistry();
registerAdminOps(registry);
