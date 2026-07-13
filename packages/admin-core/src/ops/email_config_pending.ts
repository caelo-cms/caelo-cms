// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.25 — email_config.{propose_set, execute_proposal,
 * reject_proposal, list_pending}.
 *
 * Same shape as experiment_pending (v0.2.24). New pattern: the AI's
 * proposal NEVER contains transport secrets (smtp password, resend
 * apiKey). The Owner supplies the secret inline via the form action
 * at approve time; execute_proposal merges it into the config and
 * calls setEmailConfigOp. This is the template for the same flow on
 * ai_providers (api keys) and mcp_tokens (token plaintext).
 *
 * Why this pattern instead of letting AI store + propose the secret:
 * a proposal sits in the DB until approved. Storing a credential as
 * jsonb plaintext during that window is a security regression even if
 * the row is FORCE-RLS'd; the credential lives in WAL, backups, and
 * any read path that misses the redaction. Cleaner: AI never writes a
 * secret; the secret enters at approve time on the Owner's keyboard.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, type ProposalStatus, proposalStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { setEmailConfigOp } from "./email_config.js";

const transportEnum = z.enum(["none", "smtp", "resend", "ses"]);

// Strict propose-time schema: AI may not include credential fields.
// The validator below rejects payloads that smuggle them through.
const proposeSetInput = z
  .object({
    transport: transportEnum,
    fromAddress: z.string().max(254),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Returns true iff `config` contains any field we treat as a secret
 *  for the proposed transport. We reject these at propose time so the
 *  AI never persists credential material — even an "I had to fill it
 *  with a placeholder" entry in payload jsonb is unacceptable. */
function containsTransportSecret(
  transport: z.infer<typeof transportEnum>,
  config: Record<string, unknown>,
): boolean {
  if (transport === "smtp") {
    const auth = config.auth as Record<string, unknown> | undefined;
    if (auth && (auth.pass !== undefined || auth.password !== undefined)) return true;
  }
  if (transport === "resend") {
    if (config.apiKey !== undefined) return true;
  }
  if (transport === "ses") {
    if (config.secretAccessKey !== undefined || config.accessKeyId !== undefined) return true;
  }
  return false;
}

/** Returns the list of credential field names the Owner will need to
 *  supply at approve time, given the proposed transport + config. */
function requiredOwnerSecrets(
  transport: z.infer<typeof transportEnum>,
  config: Record<string, unknown>,
): string[] {
  if (transport === "smtp") {
    // SMTP needs a password only when auth.user is set (anonymous
    // SMTP relays exist and are valid for some test setups).
    const auth = config.auth as Record<string, unknown> | undefined;
    return auth?.user ? ["smtpPassword"] : [];
  }
  if (transport === "resend") return ["resendApiKey"];
  if (transport === "ses") return ["sesAccessKeyId", "sesSecretAccessKey"];
  return [];
}

export const proposeEmailConfigSetOp = defineOperation({
  name: "email_config.propose_set",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSetInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
    requiresSecrets: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    if (containsTransportSecret(input.transport, input.config)) {
      return err({
        kind: "HandlerError",
        operation: "email_config.propose_set",
        message:
          "config contains transport secret material — credentials are supplied by the Owner at approve time, not in the proposal payload",
      });
    }
    if (input.transport !== "none" && input.fromAddress.trim() === "") {
      return err({
        kind: "HandlerError",
        operation: "email_config.propose_set",
        message: "fromAddress is required for non-`none` transports",
      });
    }
    const requiresSecrets = requiredOwnerSecrets(input.transport, input.config);
    const preview = {
      transport: input.transport,
      fromAddress: input.fromAddress,
      config: input.config,
      requiresSecrets,
    };
    const payloadHash = await hashProposalPayload(input);
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    let rows: { id: string }[];
    try {
      rows = (await tx.execute(sql`
        INSERT INTO email_config_pending_actions
          (proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          ${ctx.actorId}::uuid,
          ${jsonbParam(input)},
          ${jsonbParam(preview)},
          'pending',
          ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
          ${payloadHash}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({
          kind: "HandlerError",
          operation: "email_config.propose_set",
          message: DUPLICATE_PROPOSAL_MESSAGE,
        });
      }
      throw e;
    }
    const proposalId = rows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "email_config.propose_set",
        message: "insert returned no id",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "email_config.propose_set",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `transport=${input.transport}`,
    });
    return ok({ proposalId, preview, requiresSecrets });
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeEmailConfigProposalOp = defineOperation({
  name: "email_config.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      // Owner-supplied secrets, merged into the proposal's config at
      // execute time. None of these reach the proposal payload.
      smtpPassword: z.string().max(2048).optional(),
      resendApiKey: z.string().max(2048).optional(),
      sesAccessKeyId: z.string().max(2048).optional(),
      sesSecretAccessKey: z.string().max(2048).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, payload, status
      FROM email_config_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{ id: string; payload: unknown; status: string }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "email_config.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "email_config.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = parsePayload<{
      transport: z.infer<typeof transportEnum>;
      fromAddress: string;
      config: Record<string, unknown>;
    }>(row.payload);
    const merged = mergeOwnerSecrets(payload.transport, payload.config, input);
    const r = await setEmailConfigOp.handler(
      ctx,
      { transport: payload.transport, fromAddress: payload.fromAddress, config: merged },
      tx,
    );
    if (!r.ok) {
      const msg =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "unknown";
      return err({
        kind: "HandlerError",
        operation: "email_config.execute_proposal",
        message: `underlying email_config.set failed: ${msg}`,
      });
    }
    await tx.execute(sql`
      UPDATE email_config_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "email_config.execute_proposal",
      // Strip secrets from the audit input.
      input: { proposalId: input.proposalId, secretsProvided: collectSecretNames(input) },
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `transport=${payload.transport}`,
    });
    return ok({});
  },
});

export const rejectEmailConfigProposalOp = defineOperation({
  name: "email_config.reject_proposal",
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
      UPDATE email_config_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "email_config.reject_proposal",
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
  proposedBy: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingEmailConfigProposalsOp = defineOperation({
  name: "email_config.list_pending",
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
        id::text AS id, proposed_by::text AS proposed_by,
        payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM email_config_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      proposed_by: string;
      payload: unknown;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
      decided_at: string | Date | null;
      decided_by: string | null;
      decision_reason: string | null;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        proposedBy: r.proposed_by,
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

function mergeOwnerSecrets(
  transport: z.infer<typeof transportEnum>,
  config: Record<string, unknown>,
  secrets: {
    smtpPassword?: string;
    resendApiKey?: string;
    sesAccessKeyId?: string;
    sesSecretAccessKey?: string;
  },
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...config };
  if (transport === "smtp" && secrets.smtpPassword !== undefined) {
    const auth = (merged.auth as Record<string, unknown> | undefined) ?? {};
    merged.auth = { ...auth, pass: secrets.smtpPassword };
  }
  if (transport === "resend" && secrets.resendApiKey !== undefined) {
    merged.apiKey = secrets.resendApiKey;
  }
  if (transport === "ses") {
    if (secrets.sesAccessKeyId !== undefined) merged.accessKeyId = secrets.sesAccessKeyId;
    if (secrets.sesSecretAccessKey !== undefined)
      merged.secretAccessKey = secrets.sesSecretAccessKey;
  }
  return merged;
}

function collectSecretNames(input: {
  smtpPassword?: string;
  resendApiKey?: string;
  sesAccessKeyId?: string;
  sesSecretAccessKey?: string;
}): string[] {
  const names: string[] = [];
  if (input.smtpPassword !== undefined) names.push("smtpPassword");
  if (input.resendApiKey !== undefined) names.push("resendApiKey");
  if (input.sesAccessKeyId !== undefined) names.push("sesAccessKeyId");
  if (input.sesSecretAccessKey !== undefined) names.push("sesSecretAccessKey");
  return names;
}
