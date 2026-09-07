// SPDX-License-Identifier: MPL-2.0

import { externalArtifactDigest, validateSelectedGrants } from "@caelo-cms/plugin-sandbox";
import { type PluginCapability, pluginManifest } from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

export interface ExternalApproval {
  readonly artifactDigest: string;
  readonly grantIds: readonly string[];
  readonly capabilities: readonly PluginCapability[];
  readonly systemActorId: string;
}
type AdminTx = Parameters<Parameters<DatabaseAdapter["withAdminTransaction"]>[1]>[0];

/** Holding the registry row until work commits serializes storage calls against revocation/update. */
export async function withExternalAuthorization<T>(
  plugin: Pick<LoadedPlugin, "pluginId" | "externalApproval">,
  infra: PluginHostInfra,
  work: (tx: AdminTx) => Promise<T>,
): Promise<T> {
  const approval = plugin.externalApproval;
  if (!approval) throw new Error("ExternalPluginApprovalMissing");
  return infra.adapter.withAdminTransaction(
    {
      actorId: approval.systemActorId,
      actorKind: "system",
      requestId: "external-plugin-authorize",
    },
    async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT manifest_json,source_code,status FROM plugins WHERE id=${plugin.pluginId}::uuid FOR SHARE`,
      )) as unknown as { manifest_json: unknown; source_code: string; status: string }[];
      const row = rows[0];
      if (
        row?.status !== "active" ||
        externalArtifactDigest(row.manifest_json, row.source_code) !== approval.artifactDigest
      )
        throw new Error("ExternalPluginApprovalChanged");
      const manifest = pluginManifest.parse(row.manifest_json);
      if (manifest.requestedCapabilities?.length) {
        const receipts = (await tx.execute(
          sql`SELECT g.id::text AS id, g.capability FROM plugin_capability_grants g JOIN plugin_installation_versions v ON v.plugin_id=g.plugin_id AND v.artifact_digest=g.artifact_digest WHERE g.plugin_id=${plugin.pluginId}::uuid AND g.artifact_digest=${approval.artifactDigest} AND g.revoked_at IS NULL AND v.status='active' ORDER BY g.id`,
        )) as unknown as { id: string; capability: PluginCapability }[];
        validateSelectedGrants(
          manifest,
          receipts.map((r) => r.capability),
        );
        if (
          JSON.stringify(receipts.map((r) => r.id).sort()) !==
          JSON.stringify([...approval.grantIds].sort())
        )
          throw new Error("ExternalPluginGrantChanged");
      }
      return work(tx);
    },
  );
}

/** Restore only exact, still-active Owner receipts. A manifest declaration alone grants nothing. */
export async function readExternalApproval(opts: {
  pluginId: string;
  manifest: unknown;
  source: string;
  infra: PluginHostInfra;
  systemActorId: string;
}): Promise<ExternalApproval> {
  const manifest = pluginManifest.parse(opts.manifest);
  const digest = externalArtifactDigest(opts.manifest, opts.source);
  const grantIds = await opts.infra.adapter.withAdminTransaction(
    { actorId: opts.systemActorId, actorKind: "system", requestId: "external-plugin-load-grants" },
    async (tx) => {
      if (!manifest.requestedCapabilities?.length) return [];
      const receipts = (await tx.execute(
        sql`SELECT g.id::text AS id,g.capability FROM plugin_capability_grants g JOIN plugin_installation_versions v ON v.plugin_id=g.plugin_id AND v.artifact_digest=g.artifact_digest WHERE g.plugin_id=${opts.pluginId}::uuid AND g.artifact_digest=${digest} AND g.revoked_at IS NULL AND v.status='active' ORDER BY g.id`,
      )) as unknown as { id: string; capability: PluginCapability }[];
      validateSelectedGrants(
        manifest,
        receipts.map((r) => r.capability),
      );
      return receipts.map((r) => r.id);
    },
  );
  const approval = {
    artifactDigest: digest,
    grantIds,
    capabilities: manifest.requestedCapabilities ?? [],
    systemActorId: opts.systemActorId,
  };
  await withExternalAuthorization(
    { pluginId: opts.pluginId, externalApproval: approval },
    opts.infra,
    async () => {},
  );
  return Object.freeze(approval);
}
