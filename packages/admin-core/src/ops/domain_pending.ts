// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.30 — domains.{propose_add, propose_remove, execute_proposal,
 * reject_proposal, list_pending}.
 *
 * Same shape as mcp_token_pending (v0.2.27).
 *
 * Adding or removing a domain triggers cms-provision regenerate-caddy
 * on next deploy; the Owner gate stops AI from accidentally orphaning
 * a custom hostname. domains.verify is widened to AI in v0.2.30 (it's
 * diagnostic, not registry-mutating) so the AI can preflight DNS
 * resolution before proposing an add and surface a status indicator
 * after the Owner approves.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { addDomainOp, removeDomainOp } from "./domains.js";

const domainKind = z.enum(["admin", "public", "locale-public"]);
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// ─── propose_add ─────────────────────────────────────────────────────

const proposeAddInput = z
  .object({
    hostname: z
      .string()
      .min(1)
      .max(253)
      .transform((s) => s.toLowerCase().trim())
      .refine((s) => HOSTNAME_RE.test(s), "must be a valid hostname"),
    kind: domainKind,
    localeCode: z.string().min(2).max(20).optional(),
  })
  .strict();

export const proposeDomainAddOp = defineOperation({
  name: "domains.propose_add",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeAddInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    if (input.kind === "locale-public" && !input.localeCode) {
      return err({
        kind: "HandlerError",
        operation: "domains.propose_add",
        message: "locale-public domains require localeCode",
      });
    }
    // Reject duplicates at propose time so a typoed proposal doesn't
    // sit in the queue waiting to fail.
    const dup = (await tx.execute(sql`
      SELECT 1 AS exists FROM domains WHERE hostname = ${input.hostname} LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "domains.propose_add",
        message: `domain "${input.hostname}" already registered`,
      });
    }
    const preview = {
      kind: "add",
      hostname: input.hostname,
      domainKind: input.kind,
      localeCode: input.localeCode ?? null,
      // Always-true reminder for the Owner: applying this triggers
      // cms-provision regenerate-caddy on next deploy.
      effect: "next-deploy regenerates Caddy vhost; ACME issues TLS cert",
    };
    return queueProposal(tx, ctx, "add", null, input, preview, "domains.propose_add");
  },
});

// ─── propose_remove ──────────────────────────────────────────────────

const proposeRemoveInput = z.object({ domainId: z.string().uuid() }).strict();

export const proposeDomainRemoveOp = defineOperation({
  name: "domains.propose_remove",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRemoveInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, hostname, kind, locale_code, tls_status, last_verified_at
      FROM domains WHERE id = ${input.domainId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      hostname: string;
      kind: string;
      locale_code: string | null;
      tls_status: string;
      last_verified_at: Date | string | null;
    }>;
    const d = rows[0];
    if (!d) {
      return err({
        kind: "HandlerError",
        operation: "domains.propose_remove",
        message: `domain ${input.domainId} not found`,
      });
    }
    const preview = {
      kind: "remove",
      domainId: d.id,
      hostname: d.hostname,
      domainKind: d.kind,
      localeCode: d.locale_code,
      tlsStatus: d.tls_status,
      effect: "next-deploy drops Caddy vhost; visitors hit 404 until DNS is repointed",
    };
    return queueProposal(
      tx,
      ctx,
      "remove",
      input.domainId,
      input,
      preview,
      "domains.propose_remove",
    );
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeDomainProposalOp = defineOperation({
  name: "domains.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ domainId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, domain_id::text AS domain_id, payload, status
      FROM domain_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "add" | "remove";
      domain_id: string | null;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "domains.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "domains.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    let resultDomainId: string | null = row.domain_id;
    if (row.kind === "add") {
      const r = await addDomainOp.handler(
        ctx,
        row.payload as Parameters<typeof addDomainOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "add");
      resultDomainId = (r.value as { domainId: string }).domainId;
    } else if (row.kind === "remove") {
      const r = await removeDomainOp.handler(
        ctx,
        row.payload as Parameters<typeof removeDomainOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "remove");
    }
    await tx.execute(sql`
      UPDATE domain_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_domain_id = ${resultDomainId === null ? null : sql`${resultDomainId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "domains.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (domainId=${resultDomainId ?? "(none)"})`,
    });
    return ok({ domainId: resultDomainId });
  },
});

export const rejectDomainProposalOp = defineOperation({
  name: "domains.reject_proposal",
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
    await tx.execute(sql`
      UPDATE domain_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "domains.reject_proposal",
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
  kind: z.enum(["add", "remove"]),
  proposedBy: z.string(),
  domainId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "applied", "rejected", "superseded"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingDomainProposalsOp = defineOperation({
  name: "domains.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const limit = input.limit ?? 50;
    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id, kind, proposed_by::text AS proposed_by,
        domain_id::text AS domain_id, payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM domain_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "add" | "remove";
      proposed_by: string;
      domain_id: string | null;
      payload: unknown;
      preview: unknown;
      status: "pending" | "applied" | "rejected" | "superseded";
      created_at: string | Date;
      decided_at: string | Date | null;
      decided_by: string | null;
      decision_reason: string | null;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        domainId: r.domain_id,
        payload: r.payload as Record<string, unknown>,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        decidedAt: r.decided_at
          ? r.decided_at instanceof Date
            ? r.decided_at.toISOString()
            : String(r.decided_at)
          : null,
        decidedBy: r.decided_by,
        decisionReason: r.decision_reason,
      })),
    });
  },
});

// ─── helpers ─────────────────────────────────────────────────────────

async function queueProposal(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: { actorId: string; requestId: string },
  kind: "add" | "remove",
  domainId: string | null,
  payload: unknown,
  preview: unknown,
  opName: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const rows = (await tx.execute(sql`
    INSERT INTO domain_pending_actions
      (kind, proposed_by, domain_id, payload, preview, status)
    VALUES (
      ${kind},
      ${ctx.actorId}::uuid,
      ${domainId === null ? null : sql`${domainId}::uuid`},
      ${JSON.stringify(payload)}::jsonb,
      ${JSON.stringify(preview)}::jsonb,
      'pending'
    )
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return err({ kind: "HandlerError", operation: opName, message: "insert returned no id" });
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: payload,
    succeeded: true,
    entityId: proposalId,
    resultSummary: `kind=${kind}`,
  });
  return ok({ proposalId, preview: preview as Record<string, unknown> });
}

function passthroughError(
  error: unknown,
  kind: string,
): {
  ok: false;
  error: { kind: "HandlerError"; operation: string; message: string };
} {
  const msg =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "unknown";
  return err({
    kind: "HandlerError",
    operation: "domains.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}
