// SPDX-License-Identifier: MPL-2.0

/**
 * A plugin's public tables in both public databases (issue #1329, gateway
 * hardening P3b-1, epic #763 E10).
 *
 * The live site's gateway reads cms_public, the staging site's gateway its
 * twin cms_public_staging. A plugin's declared `schema` exists in both, with
 * the GRANTs of each table's kind for that database's own visitor login
 * (plugin-sandbox `PUBLIC_GRANT_TARGETS`): public_role in cms_public,
 * public_staging_role in cms_public_staging, neither in the other.
 *
 * Two databases, no shared transaction: the live schema is provisioned
 * first, then the staging one. Every provisioning is idempotent and every
 * load of a plugin runs it (the admin's boot, an activation, a reload), so
 * a load that stopped between the two — or an install from before the
 * staging database, whose plugins have no staging tables yet — is repaired
 * by the next load. A failed staging provisioning fails the load loudly
 * like a failed live one (the plugin's health shows it), never silently.
 */

import {
  type EmittedSchema,
  LIVE_PUBLIC_GRANT_TARGET,
  STAGING_PUBLIC_GRANT_TARGET,
  schemaFromSpec,
} from "@caelo-cms/plugin-sandbox";
import type { PluginIndexMap, PluginSchemaMap, PluginTableKinds } from "@caelo-cms/plugin-sdk";
import type { PluginHostInfra } from "./dispatch.js";

/** What a plugin declares for its public tables. */
export interface PluginPublicSchemaSpec {
  readonly pluginId: string;
  readonly slug: string;
  readonly schema: PluginSchemaMap;
  readonly indexes: PluginIndexMap | undefined;
  readonly tableKinds: PluginTableKinds | undefined;
}

/**
 * Provision `spec` in cms_public and, where the process has one, in
 * cms_public_staging ({@link PluginHostInfra.stagingAdapter}).
 *
 * @returns the live database's emitted DDL (the activation records it).
 * @throws whatever either provisioning throws; the live one runs first.
 */
export async function provisionPluginPublicSchemas(
  infra: Pick<PluginHostInfra, "adapter" | "stagingAdapter">,
  spec: PluginPublicSchemaSpec,
): Promise<EmittedSchema> {
  const live = schemaFromSpec({ ...spec, target: LIVE_PUBLIC_GRANT_TARGET });
  await infra.adapter.provisionPluginPublicSchema({ pluginId: spec.pluginId, sql: live.sql });
  if (infra.stagingAdapter) {
    const staged = schemaFromSpec({ ...spec, target: STAGING_PUBLIC_GRANT_TARGET });
    const outcome = await infra.stagingAdapter.provisionPluginPublicSchema({
      pluginId: spec.pluginId,
      sql: staged.sql,
    });
    // The staging adapter has no cms_admin side; the drop is recorded here.
    await infra.adapter.auditPluginSchemaDrop(spec.pluginId, outcome);
  }
  return live;
}

/** Drop a plugin's public schema in every public database this process reaches (uninstall). */
export async function dropPluginPublicSchemas(
  infra: Pick<PluginHostInfra, "adapter" | "stagingAdapter">,
  schemaName: string,
): Promise<void> {
  await infra.adapter.dropPluginPublicSchema({ schemaName });
  if (infra.stagingAdapter) await infra.stagingAdapter.dropPluginPublicSchema({ schemaName });
}
