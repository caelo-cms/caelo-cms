// SPDX-License-Identifier: MPL-2.0

/**
 * site_defaults.{propose_set_seo, execute_proposal, reject_proposal,
 * list_pending} — the §11.A gate in front of `site_defaults.set_seo`.
 *
 * The site SEO settings (public base URL, sitemap toggle, Organization
 * JSON-LD) used to be writable only from the Owner's Security → SEO page,
 * yet the static generator refuses to build without a base URL (#551). The
 * agent could see the blocker and had no way to clear it — the operator
 * had to leave the conversation. Now the AI proposes and the Owner approves
 * (in the chat, or for a Power-MCP caller on the Security → SEO page).
 *
 * Why every field is gated, not just the base URL: the three settings are
 * one Owner op that writes them together, they change rarely, and each is
 * published on every page — the base URL rewrites every canonical, og:url,
 * hreflang target and sitemap entry; the sitemap toggle drops sitemap.xml
 * and the robots.txt Sitemap line; the Organization JSON-LD states the
 * site's identity to search engines. A single click for a rare site-wide
 * change is cheap; a second, ungated write path for two of the three
 * fields would split one setting across two contracts.
 *
 * The proposal carries only the fields the AI wants to change. At approve
 * time the omitted ones are read fresh, so an Owner edit made while the
 * proposal waited is not silently reverted.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  checkPublicSiteBaseUrl,
  err,
  ok,
  type ProposalStatus,
  proposalStatus,
  type SiteDefaultsSetSeoInput,
  type SiteSeoProposalInput,
  siteSeoProposalInputSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { requiresApproverPermission } from "./_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { siteDefaultsSetSeoOp } from "./seo.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

interface StoredSeo {
  siteBaseUrl: string | null;
  sitemapEnabled: boolean;
  organizationJson: SiteDefaultsSetSeoInput["organizationJson"];
}

async function readStoredSeo(tx: Tx): Promise<StoredSeo | null> {
  const rows = (await tx.execute(sql`
    SELECT site_base_url, sitemap_enabled, organization_json
    FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as {
    site_base_url: string | null;
    sitemap_enabled: boolean;
    organization_json: unknown;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    siteBaseUrl: r.site_base_url,
    sitemapEnabled: r.sitemap_enabled,
    organizationJson: parsePayload<SiteDefaultsSetSeoInput["organizationJson"]>(
      r.organization_json ?? {},
    ),
  };
}

const MISSING_ROW_MESSAGE =
  "site_defaults row (id=1) is missing — the cms_admin migrations did not seed it";

// ─── propose_set_seo ─────────────────────────────────────────────────

export const proposeSiteSeoSetOp = defineOperation({
  name: "site_defaults.propose_set_seo",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: siteSeoProposalInputSchema,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const op = "site_defaults.propose_set_seo";
    let payload: SiteSeoProposalInput = input;
    if (input.siteBaseUrl !== undefined) {
      // Validated here, not only at the Owner op: the Owner approves what
      // the AI wrote, and a localhost or path-carrying base would ship
      // broken canonicals the moment it is applied.
      const checked = checkPublicSiteBaseUrl(input.siteBaseUrl, process.env.CAELO_PROVIDER);
      if (!checked.ok) {
        return err({
          kind: "HandlerError",
          operation: op,
          message: `siteBaseUrl rejected: ${checked.message}. Ask the operator for the public address of the site if you do not know it.`,
        });
      }
      payload = { ...input, siteBaseUrl: checked.url };
    }
    const current = await readStoredSeo(tx);
    if (!current) {
      return err({ kind: "HandlerError", operation: op, message: MISSING_ROW_MESSAGE });
    }
    if (payload.siteBaseUrl === undefined && !current.siteBaseUrl) {
      // `set_seo` writes all three fields and needs a base URL; a
      // sitemap- or organization-only proposal could never be applied
      // while none is stored, so refuse it before the Owner sees a card.
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "the site base URL is not configured yet, so this change cannot be applied on its own — propose again with `siteBaseUrl` (the public https origin) included alongside the other fields",
      });
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (payload.siteBaseUrl !== undefined && payload.siteBaseUrl !== current.siteBaseUrl) {
      changes.siteBaseUrl = { from: current.siteBaseUrl, to: payload.siteBaseUrl };
    }
    if (payload.sitemapEnabled !== undefined && payload.sitemapEnabled !== current.sitemapEnabled) {
      changes.sitemapEnabled = { from: current.sitemapEnabled, to: payload.sitemapEnabled };
    }
    if (
      payload.organizationJson !== undefined &&
      JSON.stringify(payload.organizationJson) !== JSON.stringify(current.organizationJson)
    ) {
      changes.organizationJson = { from: current.organizationJson, to: payload.organizationJson };
    }
    if (Object.keys(changes).length === 0) {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "nothing to change — the proposed values already match the stored SEO settings (read them with get_site_seo).",
      });
    }
    const preview = {
      changes,
      effect:
        "applies on approve; the next publish rebuilds canonical URLs, og:url, hreflang, JSON-LD, robots.txt and the sitemap from these settings",
    };
    const payloadHash = await hashProposalPayload(payload);
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    let rows: { id: string }[];
    try {
      rows = (await tx.execute(sql`
        INSERT INTO site_defaults_pending_actions
          (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'set_seo',
          ${ctx.actorId}::uuid,
          ${jsonbParam(payload)},
          ${jsonbParam(preview)},
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${payloadHash}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({ kind: "HandlerError", operation: op, message: DUPLICATE_PROPOSAL_MESSAGE });
      }
      throw e;
    }
    const proposalId = rows[0]?.id;
    if (!proposalId) {
      return err({ kind: "HandlerError", operation: op, message: "insert returned no id" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: payload,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `changes=${Object.keys(changes).join(",")}`,
    });
    return ok({ proposalId, preview });
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

const executeSiteDefaultsProposalOpDefinition = defineOperation({
  name: "site_defaults.execute_proposal",
  // Why human-only: this IS the Owner's approval (CLAUDE.md §11.A) — the AI
  // proposes via site_defaults.propose_set_seo and cannot approve itself.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    siteBaseUrl: z.string(),
    sitemapEnabled: z.boolean(),
    organizationJson: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const op = "site_defaults.execute_proposal";
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, payload, status
      FROM site_defaults_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
      FOR UPDATE
    `)) as unknown as Array<{ id: string; payload: unknown; status: string }>;
    const row = rows[0];
    if (!row) {
      return err({ kind: "HandlerError", operation: op, message: "proposal not found" });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = parsePayload<SiteSeoProposalInput>(row.payload);
    const current = await readStoredSeo(tx);
    if (!current) {
      return err({ kind: "HandlerError", operation: op, message: MISSING_ROW_MESSAGE });
    }
    const siteBaseUrl = payload.siteBaseUrl ?? current.siteBaseUrl;
    if (!siteBaseUrl) {
      // The proposal left the base URL out and none is stored: the Owner op
      // needs one, and inventing it is exactly what #551 removed.
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "the site base URL is not configured and this proposal does not set it — reject it and propose again with `siteBaseUrl` included",
      });
    }
    const merged: SiteDefaultsSetSeoInput = {
      siteBaseUrl,
      sitemapEnabled: payload.sitemapEnabled ?? current.sitemapEnabled,
      organizationJson: payload.organizationJson ?? current.organizationJson,
    };
    const r = await siteDefaultsSetSeoOp.handler(ctx, merged, tx);
    if (!r.ok) {
      const msg =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : r.error.kind;
      return err({
        kind: "HandlerError",
        operation: op,
        message: `underlying site_defaults.set_seo failed: ${msg}`,
      });
    }
    await tx.execute(sql`
      UPDATE site_defaults_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `base=${merged.siteBaseUrl},sitemap=${merged.sitemapEnabled}`,
    });
    return ok(merged);
  },
});

/** #589 — the approver must hold roles.manage (see _approver-permission.ts). */
export const executeSiteDefaultsProposalOp = requiresApproverPermission(
  ["roles.manage"],
  executeSiteDefaultsProposalOpDefinition,
);

export const rejectSiteDefaultsProposalOp = defineOperation({
  name: "site_defaults.reject_proposal",
  // Why human-only: rejecting is the Owner's decision on the AI's proposal;
  // the AI withdraws its own rows through pending_proposals.cancel.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const op = "site_defaults.reject_proposal";
    const updated = (await tx.execute(sql`
      UPDATE site_defaults_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
      RETURNING id
    `)) as unknown as { id: string }[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "proposal not found or no longer pending — it may already be applied, rejected or cancelled (list the open ones with site_defaults.list_pending)",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

const proposalRowSchema = z.object({
  id: z.string(),
  kind: z.literal("set_seo"),
  proposedBy: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
});

export const listPendingSiteDefaultsProposalsOp = defineOperation({
  name: "site_defaults.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, proposed_by::text AS proposed_by,
             payload, preview, status, created_at
      FROM site_defaults_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${input.limit ?? 50}
    `)) as unknown as Array<{
      id: string;
      kind: "set_seo";
      proposed_by: string;
      payload: unknown;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        payload: parsePayload<Record<string, unknown>>(r.payload),
        preview: parsePayload<Record<string, unknown>>(r.preview),
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});
