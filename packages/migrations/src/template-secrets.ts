// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1689 — the values migrations draw at random that must differ per
 * install. A migration run draws each once per database, so two freshly
 * migrated installs never share one. A template copy would: it copies the
 * template's rows byte for byte, and the copy's later migration runs skip
 * the files that drew them. So the template copy draws every one anew
 * ({@link drawInstallSecrets}) and republishes the gateways' projection,
 * which carries some of them into the public databases.
 *
 * `template-secrets.test.ts` scans every migration for a value drawn at
 * random and fails unless it is listed here or explained as no secret, so a
 * new migration cannot add a shared secret to every copy by omission.
 */

import { randomBytes } from "node:crypto";
import type { SQL } from "bun";

/** A per-install secret in the admin database: its singleton table, column and size. */
export interface InstallSecret {
  readonly table: string;
  readonly column: string;
  /** Random bytes, stored as lower-case hex (twice as many characters). */
  readonly bytes: number;
  /** The migration that draws it. */
  readonly migration: string;
}

export const INSTALL_SECRETS: readonly InstallSecret[] = [
  // The live gateway's cookie signing key; gateway.rotate_cookie_secret's shape.
  {
    table: "site_settings",
    column: "gateway_cookie_secret",
    bytes: 64,
    migration: "0248_gateway_role.sql",
  },
  // The staging gateway's (#1329).
  {
    table: "site_settings",
    column: "gateway_staging_cookie_secret",
    bytes: 64,
    migration: "0531_projection_releases.sql",
  },
  // The keys that sign unsubscribe links, per environment (#1432).
  {
    table: "site_settings",
    column: "mail_link_key",
    bytes: 32,
    migration: "0635_mail_link_keys.sql",
  },
  {
    table: "site_settings",
    column: "mail_link_staging_key",
    bytes: 32,
    migration: "0635_mail_link_keys.sql",
  },
  // Public by design, but the site's own: it proves the site to the engines.
  {
    table: "site_defaults",
    column: "indexnow_key",
    bytes: 16,
    migration: "0710_search_engine_feed.sql",
  },
];

/**
 * Draw every {@link INSTALL_SECRETS} value anew in the admin database `db`
 * (a copy), in one transaction. Each table holds one row; a value the
 * template never set stays unset.
 *
 * @throws when a table holds more than one row: one value per table would
 *   then be shared by its rows
 */
export async function drawInstallSecrets(db: SQL): Promise<void> {
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    for (const s of INSTALL_SECRETS) {
      for (const name of [s.table, s.column]) {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not an identifier`);
      }
      const [count] = (await tx.unsafe(`SELECT count(*)::int AS n FROM ${s.table}`)) as {
        n: number;
      }[];
      if ((count?.n ?? 0) > 1) {
        throw new Error(
          `install from template: ${s.table} holds ${count?.n} rows, but ${s.column} is drawn per install as one value`,
        );
      }
      await tx.unsafe(`UPDATE ${s.table} SET ${s.column} = $1 WHERE ${s.column} IS NOT NULL`, [
        randomBytes(s.bytes).toString("hex"),
      ]);
    }
  });
}
