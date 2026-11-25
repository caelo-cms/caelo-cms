// SPDX-License-Identifier: MPL-2.0

/**
 * Publish the gateways' projection (public-projection.ts) over three plain
 * connections — the install's admin database and both public databases —
 * outside a running admin. migrate.ts runs it after the last migration
 * target (#635, #1329), and the template copy after it drew a copy's own
 * secrets (#1689), so the copy's public databases never serve the
 * template's.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SQL } from "bun";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import {
  type ProjectionDatabases,
  type PublishReport,
  publishPublicProjection,
} from "./public-projection.js";
import { readShippedVisitorProjections } from "./shipped-declarations.js";

/** The connections {@link publishProjectionOver} publishes through; the caller closes them. */
export interface ProjectionConnections {
  readonly admin: SQL;
  readonly live: SQL;
  readonly staging: SQL;
}

/**
 * Publish every projection section, comments included, as the `system`
 * actor, with the shipped plugins' declared visitor projections (an install
 * from before #1329 freezes its first release state here; with a
 * runtime-installed plugin active, the admin's boot does it instead).
 */
export async function publishProjectionOver(
  clients: ProjectionConnections,
): Promise<PublishReport> {
  const admin = drizzle(clients.admin);
  const pub = { live: drizzle(clients.live), staging: drizzle(clients.staging) };
  const asSystem = dsql`SELECT set_config('caelo.actor_kind', 'system', true)`;
  const dbs: ProjectionDatabases = {
    readAdmin: (fn) =>
      admin.transaction(async (tx) => {
        await tx.execute(asSystem);
        return fn(tx);
      }),
    writePublic: (target, fn) =>
      pub[target].transaction(async (tx) => {
        await tx.execute(asSystem);
        await fn(tx);
      }),
  };
  const plugins = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins");
  return publishPublicProjection(dbs, readShippedVisitorProjections(plugins), { comments: true });
}
