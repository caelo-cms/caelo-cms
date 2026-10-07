// SPDX-License-Identifier: MPL-2.0
import { SQL } from "bun";

/**
 * Pin `site_defaults.site_language` for a test file and return a restore
 * function. Migration 0232 removed the `en` default, so anything that
 * builds pages (static generator) or asserts the preview's missing-content
 * markers needs the language as explicit fixture data; restoring keeps the
 * shared test database free of drift.
 */
export async function pinSiteLanguage(
  adminUrl: string,
  language: string | null,
): Promise<() => Promise<void>> {
  const sql = new SQL(adminUrl);
  try {
    const before = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx`SELECT site_language FROM site_defaults WHERE id = 1`;
      await tx`UPDATE site_defaults SET site_language = ${language} WHERE id = 1`;
      return (rows[0] as { site_language: string | null } | undefined)?.site_language ?? null;
    });
    return async () => {
      const restore = new SQL(adminUrl);
      try {
        await restore.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          await tx`UPDATE site_defaults SET site_language = ${before} WHERE id = 1`;
        });
      } finally {
        await restore.end();
      }
    };
  } finally {
    await sql.end();
  }
}
