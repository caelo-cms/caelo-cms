// SPDX-License-Identifier: MPL-2.0

/**
 * What waits for the Owner's decision on a plugin, and the decision itself
 * (#1267, #1332, #1420).
 *
 * A release that asks for a new capability or changes its manifest stops
 * the plugin until the Owner approves it. That state is derived from the
 * plugin row, so it needs no notification row that could go stale: every
 * surface (bell, strip, dashboard, Updates, chat) reads
 * {@link readPluginApprovals} and clears by itself after the approval.
 *
 * Approving is an Owner grant. The AI may only ask for it:
 * `plugins.propose_approve_release` puts a card in the chat, and the click
 * applies it through `plugins.execute_proposal`.
 */

import {
  PLUGIN_CAPABILITY_INFO,
  type PluginManifest,
  pluginCapability,
} from "@caelo-cms/plugin-sdk";
import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { jsonbParam } from "../../sql-helpers.js";
import { requiresApproverPermission } from "../_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { describeManifestChanges } from "./manifest-changes.js";
import {
  APPROVE_REQUESTED,
  approvedDigestOf,
  releaseUnapprovedOf,
  unapprovedOf,
} from "./registry.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** The right to decide on a plugin, the same as for activating or uninstalling one. */
export const PLUGIN_APPROVER_PERMISSIONS = ["settings.write", "plugins.install"] as const;

const capabilityRequest = z.object({
  id: z.string(),
  label: z.string(),
  allows: z.string(),
  /** The author's own explanation: untrusted, shown as theirs. */
  authorReason: z.string().nullable(),
});

const manifestChange = z.object({
  area: z.string(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});

const releaseApproval = z.object({
  slug: z.string(),
  version: z.string(),
  /** The digest the approval is bound to: a newer release is refused, not approved unseen. */
  manifestDigest: z.string(),
  capabilities: z.array(capabilityRequest),
  /** Null: the approved manifest was never recorded, so what changed is unknown. */
  changes: z.array(manifestChange).nullable(),
});
type ReleaseApproval = z.infer<typeof releaseApproval>;

const installationReview = z.object({
  slug: z.string(),
  version: z.string(),
  /** An update of a plugin that is running, not a new one. */
  isUpdate: z.boolean(),
});

const pluginApprovals = z.object({
  /** Active plugins that do not run until the Owner approves their release; Publish live refuses. */
  releases: z.array(releaseApproval),
  /** Installed packages waiting for the Owner's review; nothing is stopped by them. */
  reviews: z.array(installationReview),
});
export type PluginApprovals = z.infer<typeof pluginApprovals>;

interface WaitingRow {
  slug: string;
  version: string;
  tier: number;
  status: string;
  manifest_json: unknown;
  approved_capabilities: string[] | null;
  approved_manifest_digest: string | null;
  approved_manifest_json: unknown;
}

const WAITING_COLUMNS = sql`slug, version, tier, status, manifest_json, approved_capabilities,
  approved_manifest_digest, approved_manifest_json`;

/** `row` as a waiting release, or null when it has nothing to approve. */
function toReleaseApproval(row: WaitingRow): ReleaseApproval | null {
  const unapproved = unapprovedOf(row);
  const changed = releaseUnapprovedOf(row);
  if (unapproved.length === 0 && !changed) return null;
  const manifestDigest = approvedDigestOf(row);
  if (manifestDigest === null) return null;
  const reasons = (row.manifest_json as PluginManifest).capabilityReasons;
  return {
    slug: row.slug,
    version: row.version,
    manifestDigest,
    capabilities: unapproved.map((id) => {
      const known = pluginCapability.safeParse(id);
      // A manifest passed the same enum when it was verified, so this names
      // a capability of a newer SDK: the Owner must see that, not a blank.
      if (!known.success) {
        return {
          id,
          label: id,
          allows: "Caelo has no description of this permission.",
          authorReason: null,
        };
      }
      return {
        id,
        ...PLUGIN_CAPABILITY_INFO[known.data],
        authorReason: reasons?.[known.data] ?? null,
      };
    }),
    changes:
      row.approved_manifest_json === null
        ? null
        : describeManifestChanges(row.approved_manifest_json, row.manifest_json),
  };
}

/**
 * Everything that waits for an Owner's decision on a plugin. A disabled
 * plugin is not listed: it stops nothing, and re-enabling it is the decision.
 */
export async function readPluginApprovals(tx: Tx): Promise<PluginApprovals> {
  const rows = (await tx.execute(sql`
    SELECT ${WAITING_COLUMNS} FROM plugins
     WHERE tier = 1 AND status = 'active'
     ORDER BY slug
  `)) as unknown as WaitingRow[];
  const reviews = (await tx.execute(sql`
    SELECT DISTINCT ON (p.slug) p.slug, v.manifest_json ->> 'version' AS version,
           p.status = 'active' AS is_update
      FROM plugin_installation_versions v
      JOIN plugins p ON p.id = v.plugin_id
     WHERE v.status = 'pending'
     ORDER BY p.slug, v.created_at DESC
  `)) as unknown as { slug: string; version: string; is_update: boolean }[];
  return {
    releases: rows.flatMap((row) => {
      const release = toReleaseApproval(row);
      return release ? [release] : [];
    }),
    reviews: reviews.map((r) => ({ slug: r.slug, version: r.version, isUpdate: r.is_update })),
  };
}

export const listPluginApprovalsOp = defineOperation({
  name: "plugins.list_approvals",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: pluginApprovals,
  handler: async (_ctx, _input, tx) => ok(await readPluginApprovals(tx)),
});

const approveInput = z
  .object({
    slug: z.string().min(1).max(120),
    /** The digest the Owner was shown (#1332): a release that replaced it is refused. */
    manifestDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

/** The approval itself: records it and closes any card still asking for it. */
async function approveRelease(
  ctx: ExecutionContext,
  tx: Tx,
  operation: string,
  input: z.infer<typeof approveInput>,
) {
  const current = (
    (await tx.execute(sql`
      SELECT manifest_json FROM plugins
       WHERE slug = ${input.slug} AND tier = 1 AND status IN ('active', 'disabled')
       FOR UPDATE
    `)) as unknown as { manifest_json: unknown }[]
  )[0];
  if (!current) {
    return err({
      kind: "HandlerError" as const,
      operation,
      message: `no active or disabled release-signed plugin "${input.slug}" — activate a new plugin with plugins.activate; an installed one approves its grants in the installation review`,
    });
  }
  const digest = approvedDigestOf(current);
  if (input.manifestDigest !== undefined && input.manifestDigest !== digest) {
    return err({
      kind: "HandlerError" as const,
      operation,
      message: `plugin "${input.slug}" was replaced by another release since you looked at it — review it again`,
    });
  }
  // #1332 — the approval covers the whole manifest, not only its
  // capability set: both are recorded together.
  const rows = (await tx.execute(sql`
    UPDATE plugins SET approved_capabilities = ${APPROVE_REQUESTED},
                       approved_manifest_digest = ${digest},
                       approved_manifest_json = manifest_json,
                       updated_at = now()
     WHERE slug = ${input.slug} AND tier = 1
    RETURNING id::text AS id, approved_capabilities
  `)) as unknown as { id: string; approved_capabilities: string[] }[];
  const row = rows[0];
  if (!row) throw new Error(`${operation}: the locked row vanished`);
  await tx.execute(sql`
    UPDATE plugin_pending_actions
       SET status = 'applied', decided_by = ${ctx.actorId}::uuid, decided_at = now()
     WHERE plugin_id = ${row.id}::uuid AND kind = 'approve_release' AND status = 'pending'
  `);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation,
    input,
    succeeded: true,
    entityId: row.id,
    resultSummary: `approved=${row.approved_capabilities.join(",")}`,
  });
  return ok({ approved: row.approved_capabilities });
}

export const approvePluginCapabilitiesOp = requiresApproverPermission(
  PLUGIN_APPROVER_PERMISSIONS,
  defineOperation({
    name: "plugins.approve_capabilities",
    readScope: "request",
    // Why human-only: approving a capability is an Owner grant (CLAUDE.md §2,
    // one plugin model) — the same decision as activating the plugin.
    actorScope: ["human", "system"],
    database: "cms_admin",
    input: approveInput,
    output: z.object({ approved: z.array(z.string()) }),
    handler: (ctx, input, tx) => approveRelease(ctx, tx, "plugins.approve_capabilities", input),
  }),
);

export const proposeApproveReleaseInput = z
  .object({
    slug: z.string().min(1).max(120),
    /** Binds the card to this release, however long it stays open. */
    manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
type ProposeApproveReleaseInput = z.infer<typeof proposeApproveReleaseInput>;

/** The waiting release `input` names, or the error that tells the AI what to do instead. */
async function waitingRelease(tx: Tx, operation: string, input: ProposeApproveReleaseInput) {
  const row = (
    (await tx.execute(sql`
      SELECT id::text AS id, ${WAITING_COLUMNS} FROM plugins WHERE slug = ${input.slug}
    `)) as unknown as (WaitingRow & { id: string })[]
  )[0];
  const release = row?.status === "active" ? toReleaseApproval(row) : null;
  if (!row || !release) {
    return err({
      kind: "HandlerError" as const,
      operation,
      message: `plugin "${input.slug}" has no release waiting for approval — check \`list_plugins\`; only an active plugin with health \`awaiting_approval\` needs this`,
    });
  }
  if (release.manifestDigest !== input.manifestDigest) {
    return err({
      kind: "HandlerError" as const,
      operation,
      message: `plugin "${input.slug}" now waits with another release — call again with manifestDigest ${release.manifestDigest}`,
    });
  }
  return ok({ pluginId: row.id, release });
}

/** The release in the Owner's words, for the chat's approval card. */
function describeRelease(release: ReleaseApproval): string {
  const lines = [`Approve the new release of ${release.slug} (${release.version}). It runs again.`];
  if (release.capabilities.length > 0) {
    lines.push("", "New permissions:");
    for (const c of release.capabilities) lines.push(`- ${c.label}: ${c.allows}`);
  }
  if (release.changes === null) {
    lines.push("", "What else changed is unknown: the approved version was not recorded.");
  } else if (release.changes.length > 0) {
    lines.push("", "What changed:");
    for (const c of release.changes) {
      const parts = [
        c.added.length > 0 ? `added ${c.added.join(", ")}` : null,
        c.removed.length > 0 ? `removed ${c.removed.join(", ")}` : null,
        c.changed.length > 0 ? `changed ${c.changed.join(", ")}` : null,
      ].filter((p) => p !== null);
      lines.push(`- ${c.area}: ${parts.join("; ")}`);
    }
  }
  return lines.join("\n");
}

export const previewApproveReleaseOp = defineOperation({
  name: "plugins.preview_approve_release",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeApproveReleaseInput,
  output: z.object({ preview: z.string() }),
  handler: async (_ctx, input, tx) => {
    const found = await waitingRelease(tx, "plugins.preview_approve_release", input);
    if (!found.ok) return found;
    return ok({ preview: describeRelease(found.value.release) });
  },
});

export const proposeApproveReleaseOp = defineOperation({
  name: "plugins.propose_approve_release",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeApproveReleaseInput,
  output: z.object({ proposalId: z.string(), preview: z.record(z.string(), z.unknown()) }),
  handler: async (ctx, input, tx) => {
    const op = "plugins.propose_approve_release";
    const found = await waitingRelease(tx, op, input);
    if (!found.ok) return found;
    const { pluginId, release } = found.value;
    const payload = { slug: input.slug, manifestDigest: release.manifestDigest };
    const preview = {
      slug: release.slug,
      version: release.version,
      newPermissions: release.capabilities.map((c) => `${c.label}: ${c.allows}`),
      changes:
        release.changes === null
          ? "unknown: the approved version was not recorded"
          : release.changes.map((c) => c.area),
      effect: `"${input.slug}" runs again, with these permissions.`,
    };
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
    let inserted: { id: string }[];
    try {
      inserted = (await tx.execute(sql`
        INSERT INTO plugin_pending_actions
          (kind, proposed_by, plugin_id, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'approve_release',
          ${ctx.actorId}::uuid,
          ${pluginId}::uuid,
          ${jsonbParam(payload)},
          ${jsonbParam(preview)},
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${await hashProposalPayload({ kind: "approve_release", ...payload })}
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
      entityId: pluginId,
      resultSummary: `${input.slug}: approve release ${release.version}`,
    });
    return ok({ proposalId, preview });
  },
});

/**
 * Apply an approved `approve_release` row. `ctx` is the approver's: the
 * executor's approver permission has already been checked. The stored
 * digest refuses a release that replaced the one the card showed.
 */
export async function applyApproveReleaseProposal(
  ctx: ExecutionContext,
  tx: Tx,
  rawPayload: unknown,
) {
  const payload = rawPayload as { slug: string; manifestDigest: string };
  const r = await approveRelease(ctx, tx, "plugins.execute_proposal", payload);
  if (!r.ok) return r;
  return ok({ slug: payload.slug, approvedCapabilities: r.value.approved });
}
