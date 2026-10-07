// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin capability grants, from the agent's side (CLAUDE.md §11.A).
 *
 * - `plugins.list_capability_grants` — what each installed plugin version
 *   has been granted. A read, open to the AI: grants are the Owner's
 *   decisions, not secrets, and the AI cannot propose revoking a grant it
 *   cannot see.
 * - `plugins.propose_revoke_capability` — the AI proposes taking one grant
 *   away. Gated rather than routine: when the grant belongs to the running
 *   version the plugin is disabled, and undoing that is a fresh Owner
 *   approval of the installation, not one tool call.
 * - `applyRevokeCapabilityProposal` — the apply half, called by
 *   `plugins.execute_proposal` for `kind = 'revoke_capability'` after the
 *   operator's Approve. It runs `plugins.revoke_capability`'s own handler,
 *   so the `plugins.install` permission check on the approver, the
 *   grant/version bookkeeping and the audit row are the Owner page's.
 */

import { applyPluginLifecycle } from "@caelo-cms/plugin-host";
import { externalArtifactDigest } from "@caelo-cms/plugin-sandbox";
import { pluginCapability } from "@caelo-cms/plugin-sdk";
import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { jsonbParam } from "../../sql-helpers.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { revokePluginCapabilityOp } from "./installations.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

const grantRow = z.object({
  slug: z.string(),
  installationId: z.string(),
  /** `active` = the running version; `approved` = an update waiting to run. */
  installationStatus: z.string(),
  /** The plugin's own status: an `active` installation of a `disabled`
   *  plugin holds grants but is not running. */
  pluginStatus: z.string(),
  capability: z.string(),
  approvedAt: z.string(),
});

export const listPluginCapabilityGrantsOp = defineOperation({
  name: "plugins.list_capability_grants",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120).optional() }).strict(),
  output: z.object({ grants: z.array(grantRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT p.slug, v.id::text AS installation_id, v.status AS installation_status,
             p.status AS plugin_status, g.capability, g.approved_at
      FROM plugin_capability_grants g
      JOIN plugins p ON p.id = g.plugin_id
      JOIN plugin_installation_versions v
        ON v.plugin_id = g.plugin_id AND v.artifact_digest = g.artifact_digest
      WHERE g.revoked_at IS NULL
        AND v.status IN ('active', 'approved')
        ${input.slug ? sql`AND p.slug = ${input.slug}` : sql``}
      ORDER BY p.slug, v.status, g.capability
    `)) as unknown as Array<{
      slug: string;
      installation_id: string;
      installation_status: string;
      plugin_status: string;
      capability: string;
      approved_at: string | Date;
    }>;
    return ok({
      grants: rows.map((r) => ({
        slug: r.slug,
        installationId: r.installation_id,
        installationStatus: r.installation_status,
        pluginStatus: r.plugin_status,
        capability: r.capability,
        approvedAt: r.approved_at instanceof Date ? r.approved_at.toISOString() : r.approved_at,
      })),
    });
  },
});

export const proposeRevokeCapabilityInput = z
  .object({
    slug: z.string().min(1).max(120),
    capability: pluginCapability,
    /** Which version's grant: the running one (default) or a pending update's. */
    target: z.enum(["running", "pending_update"]).default("running"),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export const proposeRevokePluginCapabilityOp = defineOperation({
  name: "plugins.propose_revoke_capability",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRevokeCapabilityInput,
  output: z.object({ proposalId: z.string(), preview: z.record(z.string(), z.unknown()) }),
  handler: async (ctx, input, tx) => {
    const op = "plugins.propose_revoke_capability";
    const versionStatus = input.target === "running" ? "active" : "approved";
    const rows = (await tx.execute(sql`
      SELECT v.id::text AS installation_id, v.plugin_id::text AS plugin_id, v.artifact_digest,
             p.manifest_json, p.source_code, p.status AS plugin_status
      FROM plugin_installation_versions v JOIN plugins p ON p.id = v.plugin_id
      WHERE p.slug = ${input.slug} AND v.status = ${versionStatus}
      ORDER BY v.created_at DESC LIMIT 1
    `)) as unknown as Array<{
      installation_id: string;
      plugin_id: string;
      artifact_digest: string;
      manifest_json: unknown;
      source_code: string | null;
      plugin_status: string;
    }>;
    const v = rows[0];
    if (!v) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `plugin "${input.slug}" has no ${input.target === "running" ? "running" : "pending-update"} installation with grants. Check list_plugin_grants for what is granted.`,
      });
    }
    const granted = (await tx.execute(sql`
      SELECT 1 AS ok FROM plugin_capability_grants
      WHERE plugin_id = ${v.plugin_id}::uuid AND artifact_digest = ${v.artifact_digest}
        AND capability = ${input.capability} AND revoked_at IS NULL
      LIMIT 1
    `)) as unknown as unknown[];
    if (granted.length === 0) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `plugin "${input.slug}" holds no active "${input.capability}" grant on that version — nothing to revoke. Check list_plugin_grants.`,
      });
    }
    // Same test the apply step uses: revoking a grant of the version that
    // is actually running disables the plugin.
    const disables =
      externalArtifactDigest(v.manifest_json, v.source_code ?? "") === v.artifact_digest;
    // Stored so the apply step can refuse a stale approval: if the target
    // version changed state in between (a pending update went live), the
    // effect the operator approved is no longer the effect that would run.
    const payload = {
      slug: input.slug,
      pluginId: v.plugin_id,
      installationId: v.installation_id,
      capability: input.capability,
      expectedInstallationStatus: versionStatus,
      expectedDisables: disables,
    };
    const running = v.plugin_status === "active";
    const preview = {
      slug: input.slug,
      capability: input.capability,
      target: input.target,
      pluginStatus: v.plugin_status,
      disablesPlugin: disables,
      effect: disables
        ? running
          ? `"${input.slug}" stops running (its data is kept). Running it again needs a new Owner approval of the installation.`
          : `"${input.slug}" (currently ${v.plugin_status}) can no longer be re-enabled without a new Owner approval of the installation; its data is kept.`
        : `the pending update of "${input.slug}" is abandoned (it has to be staged and approved again); the running version is unchanged.`,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    let inserted: { id: string }[];
    try {
      inserted = (await tx.execute(sql`
        INSERT INTO plugin_pending_actions
          (kind, proposed_by, plugin_id, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'revoke_capability',
          ${ctx.actorId}::uuid,
          ${v.plugin_id}::uuid,
          ${jsonbParam(payload)},
          ${jsonbParam(preview)},
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${await hashProposalPayload({ kind: "revoke_capability", ...payload })}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({ kind: "HandlerError", operation: op, message: DUPLICATE_PROPOSAL_MESSAGE });
      }
      throw e;
    }
    const proposalId = inserted[0]?.id;
    if (!proposalId) {
      return err({ kind: "HandlerError", operation: op, message: "insert returned no id" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: v.plugin_id,
      resultSummary: `${input.slug}: revoke ${input.capability} (disables=${disables})`,
    });
    return ok({ proposalId, preview });
  },
});

/**
 * Apply an approved `revoke_capability` row. `ctx` is the approver's: the
 * underlying handler refuses an approver without `plugins.install`.
 * Marks the row applied only after the revoke succeeded.
 */
export async function applyRevokeCapabilityProposal(
  ctx: ExecutionContext,
  tx: Tx,
  proposalId: string,
  rawPayload: unknown,
) {
  const payload = parsePayload<{
    slug: string;
    installationId: string;
    capability: string;
    expectedInstallationStatus?: string;
    expectedDisables?: boolean;
  }>(rawPayload);
  const capability = pluginCapability.parse(payload.capability);
  const now = (await tx.execute(sql`
    SELECT v.status, v.artifact_digest, p.manifest_json, p.source_code
    FROM plugin_installation_versions v JOIN plugins p ON p.id = v.plugin_id
    WHERE v.id = ${payload.installationId}::uuid
  `)) as unknown as Array<{
    status: string;
    artifact_digest: string;
    manifest_json: unknown;
    source_code: string | null;
  }>;
  const current = now[0];
  const disablesNow =
    current !== undefined &&
    externalArtifactDigest(current.manifest_json, current.source_code ?? "") ===
      current.artifact_digest;
  if (
    current &&
    ((payload.expectedInstallationStatus !== undefined &&
      current.status !== payload.expectedInstallationStatus) ||
      (payload.expectedDisables !== undefined && disablesNow !== payload.expectedDisables))
  ) {
    return err({
      kind: "HandlerError" as const,
      operation: "plugins.execute_proposal",
      message: `stale proposal: the targeted version of "${payload.slug}" changed since it was proposed (now ${current.status}), so the approved effect no longer holds. Reject it and propose again.`,
    });
  }
  const r = await revokePluginCapabilityOp.handler(
    ctx,
    { installationId: payload.installationId, capability },
    tx,
  );
  if (!r.ok) {
    return err({
      kind: "HandlerError" as const,
      operation: "plugins.execute_proposal",
      message: `plugins.revoke_capability failed: ${"message" in r.error ? r.error.message : r.error.kind}`,
    });
  }
  // Same hot-update the Owner page does after its revoke: a disabled
  // plugin's tools leave the catalogue and its workers stop now, not at
  // the next restart.
  if (r.value.disabled) applyPluginLifecycle(r.value.slug, "disable");
  await tx.execute(sql`
    UPDATE plugin_pending_actions
       SET status = 'applied', decided_by = ${ctx.actorId}::uuid, decided_at = now()
     WHERE id = ${proposalId}::uuid
  `);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "plugins.execute_proposal",
    input: { proposalId },
    succeeded: true,
    entityId: proposalId,
    resultSummary: `revoked ${capability} from ${r.value.slug}; disabled=${r.value.disabled}`,
  });
  return ok({ slug: r.value.slug, revokedCapability: capability, disabled: r.value.disabled });
}
