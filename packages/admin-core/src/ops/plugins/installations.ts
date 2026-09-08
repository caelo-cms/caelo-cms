// SPDX-License-Identifier: MPL-2.0

import {
  externalArtifactDigest,
  validateInstallationPolicy,
  validatePlugin,
  validateSelectedGrants,
} from "@caelo-cms/plugin-sandbox";
import { pluginCapability, pluginManifest } from "@caelo-cms/plugin-sdk";
import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { jsonbParam } from "../../sql-helpers.js";

export const stagePluginInstallationOp = defineOperation({
  name: "plugins.stage_installation",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      manifest: z.unknown(),
      source: z.string().min(1).max(200_000),
      origin: z.enum(["external-package", "runtime-authored"]).default("external-package"),
    })
    .strict(),
  output: z.object({
    installationId: z.string().uuid(),
    pluginId: z.string().uuid(),
    artifactDigest: z.string(),
    status: z.string(),
  }),
  handler: async (ctx, input, tx) => {
    const validation = validatePlugin({
      manifest: input.manifest,
      source: input.source,
      allowExternalCapabilities: true,
    });
    const manifest = validation.manifest;
    if (!validation.ok || !manifest || manifest.tier !== 2)
      return err({
        kind: "HandlerError",
        operation: "plugins.stage_installation",
        message: `Invalid external artifact: ${validation.failures.map((f) => f.hint).join("; ")}`,
      });
    try {
      validateInstallationPolicy(manifest);
      for (const tool of manifest.tools ?? []) z.fromJSONSchema(tool.inputJsonSchema);
    } catch (error) {
      return err({
        kind: "HandlerError",
        operation: "plugins.stage_installation",
        message: (error as Error).message,
      });
    }
    const digest = externalArtifactDigest(manifest, input.source);
    const plugins = (await tx.execute(sql`
      INSERT INTO plugins (slug, version, tier, status, manifest_json, source_code, submitted_by)
      VALUES (${manifest.slug}, ${manifest.version}, 2, 'awaiting_activation', ${jsonbParam(manifest)}, ${input.source}, ${ctx.actorId}::uuid)
      ON CONFLICT (slug) DO UPDATE SET updated_at = plugins.updated_at
        WHERE plugins.tier = 2
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const pluginId = plugins[0]?.id;
    if (!pluginId)
      return err({
        kind: "HandlerError",
        operation: "plugins.stage_installation",
        message: "An external package cannot replace a release-signed plugin",
      });
    const versions = (await tx.execute(sql`
      INSERT INTO plugin_installation_versions (plugin_id, artifact_digest, manifest_json, source_code, origin, submitted_by)
      VALUES (${pluginId}::uuid, ${digest}, ${jsonbParam(manifest)}, ${input.source}, ${ctx.actorKind === "ai" ? "runtime-authored" : input.origin}, ${ctx.actorId}::uuid)
      ON CONFLICT (plugin_id, artifact_digest) DO NOTHING
      RETURNING id::text AS id, status
    `)) as unknown as { id: string; status: string }[];
    const existing = versions[0]
      ? []
      : ((await tx.execute(
          sql`SELECT id::text AS id, status FROM plugin_installation_versions WHERE plugin_id = ${pluginId}::uuid AND artifact_digest = ${digest}`,
        )) as unknown as { id: string; status: string }[]);
    const version = versions[0] ?? existing[0];
    if (!version) throw new Error("Staging did not return an installation identity");
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.stage_installation",
      input: { slug: manifest.slug, artifactDigest: digest },
      entityId: pluginId,
      succeeded: true,
      resultSummary: `staged ${manifest.version}; active source preserved`,
    });
    return ok({
      installationId: version.id,
      pluginId,
      artifactDigest: digest,
      status: version.status,
    });
  },
});

export const listPluginInstallationsOp = defineOperation({
  name: "plugins.list_installations",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    installations: z.array(
      z.object({
        id: z.string(),
        pluginId: z.string(),
        slug: z.string(),
        artifactDigest: z.string(),
        status: z.string(),
        origin: z.string(),
        manifest: z.unknown(),
        source: z.string(),
        currentManifest: z.unknown(),
        currentSource: z.string().nullable(),
        currentStatus: z.string(),
        currentStateDigest: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = await tx.execute(sql`
      SELECT v.id::text AS id, v.plugin_id::text AS "pluginId", p.slug,
        v.artifact_digest AS "artifactDigest", v.status, v.origin,
        v.manifest_json AS manifest, v.source_code AS source,
        p.manifest_json AS "currentManifest", p.source_code AS "currentSource", p.status AS "currentStatus", p.updated_at::text AS "currentUpdatedAt"
      FROM plugin_installation_versions v JOIN plugins p ON p.id = v.plugin_id
      WHERE v.status IN ('pending', 'approved', 'active', 'retired') ORDER BY v.created_at DESC LIMIT 100
    `);
    return ok({
      installations: (
        rows as unknown as {
          id: string;
          pluginId: string;
          slug: string;
          artifactDigest: string;
          status: string;
          origin: string;
          manifest: unknown;
          source: string;
          currentManifest: unknown;
          currentSource: string | null;
          currentStatus: string;
          currentUpdatedAt: Date;
        }[]
      ).map(({ currentUpdatedAt, ...row }) => ({
        ...row,
        currentStateDigest: currentStateDigest(
          row.currentManifest,
          row.currentSource,
          row.currentStatus,
          currentUpdatedAt,
        ),
      })),
    });
  },
});

type InstallationTx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

function currentStateDigest(
  manifest: unknown,
  source: string | null,
  status: string,
  updatedAt: string | Date,
): string {
  return externalArtifactDigest(
    {
      manifest,
      status,
      updatedAt: typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString(),
    },
    source ?? "",
  );
}
async function mayApprove(
  tx: InstallationTx,
  actorId: string,
  actorKind: string,
): Promise<boolean> {
  if (actorKind === "system") return true;
  if (actorKind !== "human") return false;
  const rows = (await tx.execute(sql`SELECT EXISTS (
    SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id
    JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
    WHERE u.id = ${actorId}::uuid AND u.deleted_at IS NULL AND p.name = 'plugins.install'
  ) AS allowed`)) as unknown as { allowed: boolean }[];
  return rows[0]?.allowed === true;
}
const installationDecision = z
  .object({
    installationId: z.string().uuid(),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expectedStateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z.array(pluginCapability).max(32),
  })
  .strict();

/** Records the authenticated Owner decision. The host provisions and activates only afterwards. */
export const approvePluginInstallationOp = defineOperation({
  name: "plugins.approve_installation",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: installationDecision,
  output: z.object({
    installationId: z.string(),
    artifactDigest: z.string(),
    grantIds: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    if (!(await mayApprove(tx, ctx.actorId, ctx.actorKind)))
      return err({
        kind: "HandlerError",
        operation: "plugins.approve_installation",
        message: "plugins.install permission required",
      });
    const rows = (await tx.execute(sql`
      SELECT v.plugin_id::text AS plugin_id, v.artifact_digest, v.manifest_json, v.source_code, v.status,
        p.manifest_json AS current_manifest, p.source_code AS current_source, p.status AS current_status, p.updated_at::text AS updated_at
      FROM plugin_installation_versions v JOIN plugins p ON p.id = v.plugin_id
      WHERE v.id = ${input.installationId}::uuid FOR UPDATE OF p, v
    `)) as unknown as {
      plugin_id: string;
      artifact_digest: string;
      manifest_json: unknown;
      source_code: string;
      status: string;
      current_manifest: unknown;
      current_source: string | null;
      current_status: string;
      updated_at: Date;
    }[];
    const version = rows[0];
    if (
      !version ||
      version.artifact_digest !== input.artifactDigest ||
      externalArtifactDigest(version.manifest_json, version.source_code) !== input.artifactDigest
    )
      return err({
        kind: "HandlerError",
        operation: "plugins.approve_installation",
        message: "Artifact missing or changed; review the current package",
      });
    if (
      currentStateDigest(
        version.current_manifest,
        version.current_source,
        version.current_status,
        version.updated_at,
      ) !== input.expectedStateDigest
    )
      return err({
        kind: "HandlerError",
        operation: "plugins.approve_installation",
        message: "Installation changed since review; refresh before approving",
      });
    if (version.status === "active" && version.current_status === "active")
      return err({
        kind: "HandlerError",
        operation: "plugins.approve_installation",
        message: "This artifact is already active",
      });
    const manifest = pluginManifest.parse(version.manifest_json);
    try {
      validateSelectedGrants(manifest, input.capabilities);
    } catch (error) {
      return err({
        kind: "HandlerError",
        operation: "plugins.approve_installation",
        message: (error as Error).message,
      });
    }
    await tx.execute(
      sql`UPDATE plugin_capability_grants SET revoked_at = now(), revoked_by = ${ctx.actorId}::uuid WHERE plugin_id = ${version.plugin_id}::uuid AND artifact_digest = ${input.artifactDigest} AND revoked_at IS NULL`,
    );
    const grantIds: string[] = [];
    for (const capability of input.capabilities) {
      const inserted =
        (await tx.execute(sql`INSERT INTO plugin_capability_grants (plugin_id, artifact_digest, capability, constraints, approved_by)
        VALUES (${version.plugin_id}::uuid, ${input.artifactDigest}, ${capability}, ${jsonbParam(manifest.capabilityConstraints?.[capability] ?? {})}, ${ctx.actorId}::uuid) RETURNING id::text AS id`)) as unknown as {
          id: string;
        }[];
      if (!inserted[0]) throw new Error("Grant receipt was not recorded");
      grantIds.push(inserted[0].id);
    }
    await tx.execute(
      sql`UPDATE plugin_installation_versions SET status = 'approved', expected_state_digest = ${input.expectedStateDigest}, approved_by = ${ctx.actorId}::uuid, approved_at = now() WHERE id = ${input.installationId}::uuid`,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.approve_installation",
      input,
      entityId: version.plugin_id,
      succeeded: true,
      resultSummary: `Owner approved ${input.artifactDigest}; activation pending`,
    });
    return ok({
      installationId: input.installationId,
      artifactDigest: input.artifactDigest,
      grantIds,
    });
  },
});

export const getApprovedPluginInstallationOp = defineOperation({
  name: "plugins.get_approved_installation",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ installationId: z.string().uuid() }).strict(),
  output: z.object({
    status: z.enum(["approved", "active"]),
    pluginId: z.string(),
    artifactDigest: z.string(),
    manifest: z.unknown(),
    source: z.string(),
    previousManifest: z.unknown(),
    grantIds: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const rows =
      (await tx.execute(sql`SELECT v.status, v.plugin_id::text AS plugin_id, v.artifact_digest, v.manifest_json, v.source_code, p.manifest_json AS previous_manifest
      FROM plugin_installation_versions v JOIN plugins p ON p.id = v.plugin_id
      WHERE v.id = ${input.installationId}::uuid AND (v.status = 'approved' OR (v.status = 'active' AND p.status = 'active' AND p.manifest_json = v.manifest_json AND p.source_code = v.source_code))`)) as unknown as {
        status: "approved" | "active";
        plugin_id: string;
        artifact_digest: string;
        manifest_json: unknown;
        source_code: string;
        previous_manifest: unknown;
      }[];
    const row = rows[0];
    if (!row)
      return err({
        kind: "HandlerError",
        operation: "plugins.get_approved_installation",
        message: "Installation is not approved",
      });
    const grants = (await tx.execute(
      sql`SELECT id::text AS id, capability FROM plugin_capability_grants WHERE plugin_id=${row.plugin_id}::uuid AND artifact_digest=${row.artifact_digest} AND revoked_at IS NULL ORDER BY id`,
    )) as unknown as { id: string; capability: z.infer<typeof pluginCapability> }[];
    validateSelectedGrants(
      pluginManifest.parse(row.manifest_json),
      grants.map((g) => g.capability),
    );
    return ok({
      status: row.status,
      pluginId: row.plugin_id,
      artifactDigest: row.artifact_digest,
      manifest: row.manifest_json,
      source: row.source_code,
      previousManifest: row.previous_manifest,
      grantIds: grants.map((g) => g.id),
    });
  },
});

/** Internal completion after the host's schema and registration preflight; never callable by plugin or AI. */
export const finalizePluginInstallationOp = defineOperation({
  name: "plugins.finalize_installation",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      installationId: z.string().uuid(),
      artifactDigest: z.string(),
      grantIds: z.array(z.string()),
    })
    .strict(),
  output: z.object({ slug: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows =
      (await tx.execute(sql`SELECT v.plugin_id::text AS plugin_id,v.artifact_digest,v.manifest_json,v.source_code,v.expected_state_digest,v.approved_by::text AS approved_by,
      p.manifest_json AS current_manifest,p.source_code AS current_source,p.status AS current_status,p.updated_at::text AS updated_at
      FROM plugin_installation_versions v JOIN plugins p ON p.id=v.plugin_id WHERE v.id=${input.installationId}::uuid AND v.status='approved' FOR UPDATE OF p,v`)) as unknown as {
        plugin_id: string;
        artifact_digest: string;
        manifest_json: unknown;
        source_code: string;
        expected_state_digest: string;
        approved_by: string;
        current_manifest: unknown;
        current_source: string | null;
        current_status: string;
        updated_at: Date;
      }[];
    const row = rows[0];
    if (
      !row ||
      row.artifact_digest !== input.artifactDigest ||
      externalArtifactDigest(row.manifest_json, row.source_code) !== input.artifactDigest ||
      row.expected_state_digest !==
        currentStateDigest(
          row.current_manifest,
          row.current_source,
          row.current_status,
          row.updated_at,
        )
    )
      return err({
        kind: "HandlerError",
        operation: "plugins.finalize_installation",
        message: "Installation changed or was revoked during preparation",
      });
    const grants = (await tx.execute(
      sql`SELECT id::text AS id,capability FROM plugin_capability_grants WHERE plugin_id=${row.plugin_id}::uuid AND artifact_digest=${row.artifact_digest} AND revoked_at IS NULL ORDER BY id`,
    )) as unknown as { id: string; capability: z.infer<typeof pluginCapability> }[];
    if (
      JSON.stringify(grants.map((g) => g.id).sort()) !== JSON.stringify([...input.grantIds].sort())
    )
      return err({
        kind: "HandlerError",
        operation: "plugins.finalize_installation",
        message: "Grant receipts changed during preparation",
      });
    const manifest = pluginManifest.parse(row.manifest_json);
    validateSelectedGrants(
      manifest,
      grants.map((g) => g.capability),
    );
    await tx.execute(
      sql`UPDATE plugin_installation_versions SET status='retired' WHERE plugin_id=${row.plugin_id}::uuid AND status='active'`,
    );
    await tx.execute(
      sql`UPDATE plugin_capability_grants SET revoked_at=now(),revoked_by=${row.approved_by}::uuid WHERE plugin_id=${row.plugin_id}::uuid AND artifact_digest<>${row.artifact_digest} AND revoked_at IS NULL`,
    );
    await tx.execute(
      sql`UPDATE plugins SET version=${manifest.version},manifest_json=${jsonbParam(manifest)},source_code=${row.source_code},status='active',activated_by=${row.approved_by}::uuid,activated_at=now(),disabled_by=NULL,disabled_at=NULL,updated_at=now() WHERE id=${row.plugin_id}::uuid AND tier=2`,
    );
    await tx.execute(
      sql`UPDATE plugin_installation_versions SET status='active' WHERE id=${input.installationId}::uuid`,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.finalize_installation",
      input,
      entityId: row.plugin_id,
      succeeded: true,
      resultSummary: `activated approved artifact ${row.artifact_digest}`,
    });
    return ok({ slug: manifest.slug });
  },
});

export const revokePluginCapabilityOp = defineOperation({
  name: "plugins.revoke_capability",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ installationId: z.string().uuid(), capability: pluginCapability }).strict(),
  output: z.object({ slug: z.string(), disabled: z.boolean() }),
  handler: async (ctx, input, tx) => {
    if (!(await mayApprove(tx, ctx.actorId, ctx.actorKind)))
      return err({
        kind: "HandlerError",
        operation: "plugins.revoke_capability",
        message: "plugins.install permission required",
      });
    const rows =
      (await tx.execute(sql`SELECT v.plugin_id::text AS plugin_id,v.artifact_digest,p.slug,p.manifest_json,p.source_code
      FROM plugin_installation_versions v JOIN plugins p ON p.id=v.plugin_id WHERE v.id=${input.installationId}::uuid FOR UPDATE OF p,v`)) as unknown as {
        plugin_id: string;
        artifact_digest: string;
        slug: string;
        manifest_json: unknown;
        source_code: string;
      }[];
    const row = rows[0];
    if (!row)
      return err({
        kind: "HandlerError",
        operation: "plugins.revoke_capability",
        message: "Installation not found",
      });
    const revoked = (await tx.execute(
      sql`UPDATE plugin_capability_grants SET revoked_at=now(),revoked_by=${ctx.actorId}::uuid WHERE plugin_id=${row.plugin_id}::uuid AND artifact_digest=${row.artifact_digest} AND capability=${input.capability} AND revoked_at IS NULL RETURNING id`,
    )) as unknown as { id: string }[];
    if (!revoked.length)
      return err({
        kind: "HandlerError",
        operation: "plugins.revoke_capability",
        message: "No active grant for that capability",
      });
    const disabled =
      externalArtifactDigest(row.manifest_json, row.source_code) === row.artifact_digest;
    if (disabled)
      await tx.execute(
        sql`UPDATE plugins SET status='disabled',disabled_by=${ctx.actorId}::uuid,disabled_at=now(),updated_at=now() WHERE id=${row.plugin_id}::uuid`,
      );
    await tx.execute(
      sql`UPDATE plugin_installation_versions SET status='retired' WHERE id=${input.installationId}::uuid`,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.revoke_capability",
      input,
      entityId: row.plugin_id,
      succeeded: true,
      resultSummary: `revoked ${input.capability}; active version disabled=${disabled}`,
    });
    return ok({ slug: row.slug, disabled });
  },
});
