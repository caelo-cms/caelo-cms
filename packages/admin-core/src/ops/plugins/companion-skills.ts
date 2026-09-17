// SPDX-License-Identifier: MPL-2.0

import type { PluginManifest } from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { jsonbParam } from "../../sql-helpers.js";

/** Runs in finalization's existing transaction and registry-row lock. Conflicts
 * roll back activation, preserving both the running package and unrelated skills. */
export async function syncExternalCompanionSkills(
  tx: TransactionRunner,
  pluginId: string,
  artifactDigest: string,
  manifest: PluginManifest,
): Promise<void> {
  for (const skill of manifest.skills ?? []) {
    const rows = (await tx.execute(sql`
      INSERT INTO skills (
        slug, display_name, description, body, allowlisted_tools, auto_engagement_hints,
        status, activated_at, plugin_id, plugin_artifact_digest, plugin_owner_slug
      ) VALUES (
        ${skill.slug}, ${skill.displayName}, ${skill.description}, ${skill.body},
        ${jsonbParam(skill.allowlistedTools ?? [])}, ${jsonbParam(skill.autoEngagementHints ?? {})},
        'active', now(), ${pluginId}::uuid, ${artifactDigest}, ${manifest.slug}
      ) ON CONFLICT (slug) DO UPDATE SET
        display_name = EXCLUDED.display_name, description = EXCLUDED.description,
        body = EXCLUDED.body, allowlisted_tools = EXCLUDED.allowlisted_tools,
        auto_engagement_hints = EXCLUDED.auto_engagement_hints,
        plugin_artifact_digest = EXCLUDED.plugin_artifact_digest,
        plugin_id = EXCLUDED.plugin_id, plugin_owner_slug = EXCLUDED.plugin_owner_slug,
        updated_at = now(),
        activated_at = CASE WHEN skills.status = 'active' THEN skills.activated_at
          WHEN skills.status = 'archived' THEN NULL ELSE now() END,
        status = CASE WHEN skills.status = 'archived' THEN 'archived' ELSE 'active' END
      WHERE skills.plugin_id = EXCLUDED.plugin_id OR
        (skills.plugin_id IS NULL AND skills.plugin_owner_slug = EXCLUDED.plugin_owner_slug
          AND skills.plugin_artifact_digest IS NOT NULL)
      RETURNING id
    `)) as unknown as { id: string }[];
    if (!rows.length)
      throw new Error(`Companion skill slug belongs to another author or plugin: ${skill.slug}`);
  }
  // Removed skills keep their prior digest and history. Availability checks hide
  // them as soon as the replacement artifact becomes active in this transaction.
}
