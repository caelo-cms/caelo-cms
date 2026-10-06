// SPDX-License-Identifier: MPL-2.0
import { SQL } from "bun";

/**
 * Pin `site_defaults.site_base_url` for a test file and return a restore
 * function. #551 removed the localhost default, so anything that renders
 * canonicals (preview, static generator) needs the base URL as explicit
 * fixture data; restoring keeps the shared test database free of drift.
 */
export async function pinSiteBaseUrl(
  adminUrl: string,
  url: string | null,
): Promise<() => Promise<void>> {
  const sql = new SQL(adminUrl);
  try {
    const before = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx`SELECT site_base_url FROM site_defaults WHERE id = 1`;
      await tx`UPDATE site_defaults SET site_base_url = ${url} WHERE id = 1`;
      return (rows[0] as { site_base_url: string | null } | undefined)?.site_base_url ?? null;
    });
    return async () => {
      const restore = new SQL(adminUrl);
      try {
        await restore.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          await tx`UPDATE site_defaults SET site_base_url = ${before} WHERE id = 1`;
        });
      } finally {
        await restore.end();
      }
    };
  } finally {
    await sql.end();
  }
}
