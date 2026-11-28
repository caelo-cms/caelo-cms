// SPDX-License-Identifier: MPL-2.0

/**
 * Empty the shipped `seo` plugin's private tables (its schema mappings and
 * its page index) for a test file. The tables survive the per-file DB reset
 * and are visible only to the plugin (RLS on `caelo.plugin_id`), so the
 * delete runs as the plugin. Call it after the plugin host loaded the
 * plugin: the reset gives the plugin a new id, and only its load points the
 * tables' policy at it, which makes the rows of earlier runs visible.
 */

import { SQL } from "bun";

export async function wipeSeoPluginRows(adminUrl: string): Promise<void> {
  const sql = new SQL(adminUrl);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe(`DO $$
        DECLARE pid text;
        BEGIN
          SELECT id::text INTO pid FROM plugins WHERE slug = 'seo';
          IF pid IS NOT NULL AND to_regclass('plugin_seo.page_index') IS NOT NULL THEN
            PERFORM set_config('caelo.plugin_id', pid, true);
            DELETE FROM plugin_seo.page_index;
            DELETE FROM plugin_seo.type_mappings;
          END IF;
        END $$`);
    });
  } finally {
    await sql.end();
  }
}
