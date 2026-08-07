// SPDX-License-Identifier: MPL-2.0

/**
 * Gated plugin activation (§11.A).
 *
 * Activation is a hard state (CLAUDE.md §2): until an Owner says yes, a
 * discovered plugin is recorded and nothing of it runs. That decision
 * used to be reachable only by leaving the conversation for
 * `/security/plugins` — the round-trip §11.A exists to remove. Here the
 * AI proposes the activation, the operator approves on the in-chat
 * card, and the plugin loads.
 *
 * Why gated rather than routine: activating runs code that was not
 * running before. It adds tools the AI can call, skills that steer it,
 * background workers, and URL contributions that reshape live page
 * paths. Undoing that is not one tool call — it is a disable plus
 * whatever the workers and URL contributions already did.
 *
 * The preview is the whole point of the card: it names what will start
 * running, so "Approve" is an informed click rather than a shrug.
 *
 * The host LOAD deliberately does not happen here. This op only flips
 * the row; the loader opens its own transaction and takes the same row,
 * so it must run after this one commits — the gated tool's `afterApply`
 * hook does it (see `gated-tools.ts`).
 */

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

/** What the manifest tells us a plugin will contribute once it runs. */
interface ActivationManifest {
  schema?: Record<string, unknown>;
  adminSchema?: Record<string, unknown>;
  urlContributions?: Array<{ slot: string }>;
  tools?: Array<{ name?: string }>;
  skills?: Array<{ slug?: string }>;
  workers?: unknown[];
  requestedCapabilities?: string[];
}

export const proposePluginActivationOp = defineOperation({
  name: "plugins.propose_activation",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z.string().min(1).max(120),
      /** Why the AI thinks this plugin should run — shown on the card
       *  so the operator sees the intent, not just the mechanics. */
      reason: z.string().max(500).optional(),
    })
    .strict(),
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, tier, status, version, manifest_json
      FROM plugins WHERE slug = ${input.slug} LIMIT 1
    `)) as unknown as {
      id: string;
      tier: number;
      status: string;
      version: string;
      manifest_json: unknown;
    }[];
    const plugin = rows[0];
    if (!plugin) {
      return err({
        kind: "HandlerError",
        operation: "plugins.propose_activation",
        message: `no plugin with slug "${input.slug}". Call list_plugins to see what is installed.`,
      });
    }
    if (plugin.status === "active") {
      return err({
        kind: "HandlerError",
        operation: "plugins.propose_activation",
        message: `plugin "${input.slug}" is already active — its tools and skills are available to you now. Do not propose an activation for it.`,
      });
    }
    if (plugin.status !== "awaiting_activation" && plugin.status !== "disabled") {
      return err({
        kind: "HandlerError",
        operation: "plugins.propose_activation",
        message: `plugin "${input.slug}" is "${plugin.status}", which cannot be activated. Only an installed (awaiting_activation) or disabled plugin can.`,
      });
    }

    const manifest = (plugin.manifest_json ?? {}) as ActivationManifest;
    const payload = {
      slug: input.slug,
      pluginId: plugin.id,
      reason: input.reason ?? null,
    };
    // Blast radius, in the operator's terms: what starts running.
    const preview = {
      slug: input.slug,
      version: plugin.version,
      currentStatus: plugin.status,
      toolsAdded: (manifest.tools ?? []).map((t) => t.name).filter(Boolean),
      skillsActivated: (manifest.skills ?? []).map((s) => s.slug).filter(Boolean),
      backgroundWorkers: (manifest.workers ?? []).length,
      urlSlotsClaimed: (manifest.urlContributions ?? []).map((c) => c.slot),
      capabilities: manifest.requestedCapabilities ?? [],
      schemasProvisioned: [
        ...Object.keys(manifest.schema ?? {}).map((t) => `cms_public.${t}`),
        ...Object.keys(manifest.adminSchema ?? {}).map((t) => `cms_admin.${t}`),
      ],
      note:
        (manifest.urlContributions ?? []).length > 0
          ? "This plugin claims URL slots — activating it can change the public paths of existing pages."
          : "Activating starts this plugin's code. It can be turned off again at /security/plugins.",
      ...(input.reason ? { reason: input.reason } : {}),
    };

    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    try {
      const inserted = (await tx.execute(sql`
        INSERT INTO plugin_pending_actions
          (kind, proposed_by, plugin_id, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'activate',
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
      if (!proposalId) throw new Error("plugins.propose_activation: insert returned no id");
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "plugins.propose_activation",
        input,
        succeeded: true,
        entityId: plugin.id,
        resultSummary: `slug=${input.slug} from=${plugin.status}`,
      });
      return ok({ proposalId, preview });
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({
          kind: "HandlerError",
          operation: "plugins.propose_activation",
          message: DUPLICATE_PROPOSAL_MESSAGE,
        });
      }
      throw e;
    }
  },
});

export const executePluginActivationOp = defineOperation({
  name: "plugins.execute_activation",
  // Why human-only (+system): §11.A — this is the click. The AI reaches
  // it only through the approved gated tool, never directly.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    slug: z.string(),
    previousStatus: z.string(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, status, payload
      FROM plugin_pending_actions
      WHERE id = ${input.proposalId}::uuid
      FOR UPDATE
    `)) as unknown as { id: string; kind: string; status: string; payload: unknown }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_activation",
        message: "proposal not found",
      });
    }
    if (row.kind !== "activate") {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_activation",
        message: `proposal is a '${row.kind}' action, not an activation`,
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_activation",
        message: `proposal is '${row.status}', not pending`,
      });
    }
    const payload = row.payload as { slug: string; pluginId: string };

    const current = (await tx.execute(sql`
      SELECT status FROM plugins WHERE id = ${payload.pluginId}::uuid FOR UPDATE
    `)) as unknown as { status: string }[];
    const previousStatus = current[0]?.status;
    if (!previousStatus) {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_activation",
        message: `plugin row for "${payload.slug}" is gone — it was uninstalled after the proposal was made`,
      });
    }
    if (previousStatus === "active") {
      return err({
        kind: "HandlerError",
        operation: "plugins.execute_activation",
        message: `plugin "${payload.slug}" is already active`,
      });
    }

    await tx.execute(sql`
      UPDATE plugins
      SET status = 'active',
          activated_by = ${ctx.actorId}::uuid,
          activated_at = now(),
          disabled_by = NULL,
          disabled_at = NULL,
          updated_at = now()
      WHERE id = ${payload.pluginId}::uuid
    `);
    await tx.execute(sql`
      UPDATE plugin_pending_actions
      SET status = 'applied', decided_by = ${ctx.actorId}::uuid, decided_at = now()
      WHERE id = ${row.id}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.execute_activation",
      input,
      succeeded: true,
      entityId: payload.pluginId,
      resultSummary: `slug=${payload.slug} ${previousStatus}→active`,
    });
    // The host load runs AFTER this commits — see the module docblock.
    return ok({ slug: payload.slug, previousStatus });
  },
});
