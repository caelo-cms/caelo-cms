// SPDX-License-Identifier: MPL-2.0

/**
 * #393 — gated plugin uninstall (§11.A).
 *
 * Uninstall DROPS the plugin's cms_public AND cms_admin schemas — data
 * loss is the point, and the proposal preview says so explicitly (table
 * list + admin-side row counts). That is squarely the hard-to-revert
 * class the human-confirmation gate exists for: the AI proposes, the
 * Owner approves in-chat, execute applies.
 *
 * Execute order inside one admin tx:
 *   1. archive plugin-shipped skills (rows survive, surface disappears);
 *   2. deregister the live runtime (tools/workers/prompt/URL slots);
 *   3. URL diff AFTER deregistration → apply moves + 301 fan-out (the
 *      generic #390 engine — pages a URL plugin had reshaped move back);
 *   4. delete the plugins row (actors FK is ON DELETE SET NULL, so the
 *      audit trail keeps its actor rows; cursors cascade);
 *   5. audit + mark applied;
 *   6. LAST: drop both schemas through the finalizer the host
 *      configured at bootstrap. Drops are idempotent DDL on other
 *      pools (not transactional with this tx) — running them last
 *      keeps the failure window minimal, and a failed execute leaves a
 *      still-pending proposal whose re-run is safe.
 */

import { deregisterPlugin, loadedPlugins } from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { applyUrlMigrationDiff, computeUrlMigrationDiff } from "../content/url_migrations.js";

/** Schema-drop hooks, configured by the host at bootstrap (the ops
 *  layer has no adapter handle; DDL on both pools lives there). */
export interface PluginUninstallFinalizer {
  dropPublicSchema(schemaName: string): Promise<void>;
  dropAdminSchema(schemaName: string): Promise<void>;
}

let finalizer: PluginUninstallFinalizer | null = null;

export function configurePluginUninstallFinalizer(f: PluginUninstallFinalizer): void {
  finalizer = f;
}

function pluginSchemaName(slug: string): string {
  return `plugin_${slug.replace(/-/g, "_")}`;
}

export const proposeUninstallPluginOp = defineOperation({
  name: "plugins.propose_uninstall",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z.string().min(1).max(120),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, tier, status, manifest_json
      FROM plugins WHERE slug = ${input.slug} LIMIT 1
    `)) as unknown as { id: string; tier: number; status: string; manifest_json: unknown }[];
    const plugin = rows[0];
    if (!plugin) {
      return err({
        kind: "HandlerError",
        operation: "plugins.propose_uninstall",
        message: `no plugin with slug "${input.slug}"`,
      });
    }
    const manifest = (plugin.manifest_json ?? {}) as {
      schema?: Record<string, unknown>;
      adminSchema?: Record<string, unknown>;
      urlContributions?: Array<{ slot: string }>;
      tools?: unknown[];
      workers?: unknown[];
    };

    // Data-loss preview: admin-side row counts are queryable here; the
    // cms_public tables are named from the manifest (its rows live on
    // the other pool — named, not counted, but unambiguously "dropped").
    const schemaName = pluginSchemaName(input.slug);
    const adminTables: Record<string, number> = {};
    for (const table of Object.keys(manifest.adminSchema ?? {})) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
      try {
        const c = (await tx.execute(
          sql.raw(`SELECT COUNT(*)::int AS n FROM "${schemaName}"."${table}"`),
        )) as unknown as { n: number }[];
        adminTables[table] = c[0]?.n ?? 0;
      } catch {
        adminTables[table] = 0;
      }
    }
    const skills = (await tx.execute(sql`
      SELECT slug FROM skills WHERE plugin_id = ${plugin.id}::uuid AND status != 'archived'
    `)) as unknown as { slug: string }[];

    const payload = { slug: input.slug, pluginId: plugin.id, reason: input.reason ?? null };
    const preview = {
      slug: input.slug,
      dataLoss: true,
      adminSchemaTables: adminTables,
      publicSchemaTables: Object.keys(manifest.schema ?? {}),
      urlSlotsReleased: (manifest.urlContributions ?? []).map((c) => c.slot),
      skillsArchived: skills.map((s) => s.slug),
      toolsRemoved: (manifest.tools ?? []).length,
      workersRemoved: (manifest.workers ?? []).length,
      warning:
        "Uninstalling DROPS both plugin schemas — every row in the tables above is permanently deleted. Pages whose URLs the plugin reshaped move back with 301 redirects.",
      ...(input.reason ? { reason: input.reason } : {}),
    };
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    try {
      const inserted = (await tx.execute(sql`
        INSERT INTO plugin_pending_actions
          (kind, proposed_by, plugin_id, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'uninstall',
          ${ctx.actorId}::uuid,
          ${plugin.id}::uuid,
          (${JSON.stringify(payload)}::text)::jsonb,
          (${JSON.stringify(preview)}::text)::jsonb,
          'pending',
          ${chatSessionId}::uuid,
          ${await hashProposalPayload(payload)}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const proposalId = inserted[0]?.id;
      if (!proposalId) throw new Error("plugins.propose_uninstall: insert returned no id");
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "plugins.propose_uninstall",
        input,
        succeeded: true,
        entityId: plugin.id,
        resultSummary: `skills=${skills.length} urlSlots=${(manifest.urlContributions ?? []).length}`,
      });
      return ok({ proposalId, preview });
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({
          kind: "HandlerError",
          operation: "plugins.propose_uninstall",
          message: DUPLICATE_PROPOSAL_MESSAGE,
        });
      }
      throw e;
    }
  },
});

export const executeUninstallPluginOp = defineOperation({
  name: "plugins.execute_proposal",
  // Why human-only (+system): §11.A — dropping schemas is data loss; the
  // Owner's click is the whole point of the gate.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    slug: z.string(),
    pagesMoved: z.number(),
    redirectsCreated: z.number(),
    skillsArchived: z.number(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, status, payload
      FROM plugin_pending_actions
      WHERE id = ${input.proposalId}::uuid
      FOR UPDATE
    `)) as unknown as { id: string; status: string; payload: unknown }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_proposal",
        message: `proposal is '${row.status}', not pending`,
      });
    }
    const payload = row.payload as { slug: string; pluginId: string };
    const slug = payload.slug;
    if (!finalizer) {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_proposal",
        message:
          "no uninstall finalizer configured — the host must call configurePluginUninstallFinalizer at bootstrap",
      });
    }

    // 1. Archive plugin-shipped skills (rows survive; surface gone).
    const archived = (await tx.execute(sql`
      UPDATE skills SET status = 'archived', decided_by = ${ctx.actorId}::uuid, decided_at = now()
      WHERE plugin_id = ${payload.pluginId}::uuid AND status != 'archived'
      RETURNING id
    `)) as unknown as { id: string }[];

    // 2. Live runtime removal — MUST precede the URL diff so the
    // plugin's contributions no longer shape fresh resolutions.
    const wasLoaded = loadedPlugins.bySlug(slug) !== undefined;
    deregisterPlugin(slug);

    // 3. URL fan-out through the generic #390 engine.
    const diff = await computeUrlMigrationDiff(tx);
    const { redirectsCreated } = await applyUrlMigrationDiff(ctx, tx, diff);

    // 4. Row removal (actors keep their audit trail via ON DELETE SET
    // NULL; plugin_event_cursors cascade).
    await tx.execute(sql`
      DELETE FROM plugin_schema_migrations WHERE plugin_id = ${payload.pluginId}::uuid
    `);
    await tx.execute(sql`DELETE FROM plugins WHERE id = ${payload.pluginId}::uuid`);

    // 5. Mark + audit.
    await tx.execute(sql`
      UPDATE plugin_pending_actions
         SET status = 'applied', decided_by = ${ctx.actorId}::uuid, decided_at = now()
       WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.execute_proposal",
      input,
      succeeded: true,
      entityId: payload.pluginId,
      resultSummary: `uninstalled slug=${slug} loaded=${wasLoaded} pages=${diff.length} skills=${archived.length}`,
    });

    // 6. Schema drops LAST (idempotent DDL on other pools).
    const schemaName = pluginSchemaName(slug);
    await finalizer.dropPublicSchema(schemaName);
    await finalizer.dropAdminSchema(schemaName);

    return ok({
      slug,
      pagesMoved: diff.length,
      redirectsCreated,
      skillsArchived: archived.length,
    });
  },
});
