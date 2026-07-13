// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.26 — ai_providers.{propose_set, propose_clear_key,
 * execute_proposal, reject_proposal, list_pending}.
 *
 * Reuses the secret-at-approve pattern from email_config_pending
 * (v0.2.25): the AI's propose_set payload NEVER contains the apiKey
 * — the proposal is rejected at validation time if it does. The Owner
 * pastes the key inline at approve time and execute_proposal merges
 * it into the underlying setAiProvidersOp call.
 *
 * propose_clear_key requires no Owner secret since it removes the
 * stored key rather than supplying one.
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
import { clearAiProviderKeyOp, setAiProvidersOp } from "./security/ai_providers.js";

const providerNameEnum = z.enum(["anthropic", "openai", "google", "local-openai-compat"]);

// ─── propose_set ─────────────────────────────────────────────────────

const proposeSetInput = z
  .object({
    name: providerNameEnum,
    displayName: z.string().min(1).max(100),
    config: z.record(z.string(), z.unknown()).default({}),
    isActive: z.boolean().default(true),
  })
  .strict();

export const proposeAiProvidersSetOp = defineOperation({
  name: "ai_providers.propose_set",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSetInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
    requiresSecrets: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    // Defense in depth: the strict() schema already drops unknown
    // keys, but we double-check the config jsonb doesn't smuggle
    // the apiKey through under a different field name.
    if (
      "apiKey" in input.config ||
      "api_key" in input.config ||
      "ANTHROPIC_API_KEY" in input.config
    ) {
      return err({
        kind: "HandlerError",
        operation: "ai_providers.propose_set",
        message:
          "config contains apiKey-shaped material — the API key is supplied by the Owner at approve time, not in the proposal payload",
      });
    }
    // Resolve whether a key already exists for this provider — if so,
    // requiresSecrets stays empty (Owner can approve without re-typing
    // the key). Otherwise the Owner must supply one.
    const existing = (await tx.execute(sql`
      SELECT (api_key_encrypted IS NOT NULL) AS has_db_key
      FROM ai_providers WHERE name = ${input.name} LIMIT 1
    `)) as unknown as { has_db_key: boolean }[];
    const requiresSecrets = existing[0]?.has_db_key ? [] : ["apiKey"];
    const preview = {
      kind: "set",
      name: input.name,
      displayName: input.displayName,
      config: input.config,
      isActive: input.isActive,
      hasExistingKey: !!existing[0]?.has_db_key,
      requiresSecrets,
    };
    return queueProposal(tx, ctx, "set", input.name, input, preview, "ai_providers.propose_set");
  },
});

// ─── propose_clear_key ───────────────────────────────────────────────

const proposeClearKeyInput = z.object({ name: providerNameEnum }).strict();

export const proposeAiProvidersClearKeyOp = defineOperation({
  name: "ai_providers.propose_clear_key",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeClearKeyInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const existing = (await tx.execute(sql`
      SELECT name, display_name, is_active,
             (api_key_encrypted IS NOT NULL) AS has_db_key
      FROM ai_providers WHERE name = ${input.name} LIMIT 1
    `)) as unknown as Array<{
      name: string;
      display_name: string;
      is_active: boolean;
      has_db_key: boolean;
    }>;
    const e = existing[0];
    if (!e) {
      return err({
        kind: "HandlerError",
        operation: "ai_providers.propose_clear_key",
        message: `provider ${input.name} not found`,
      });
    }
    if (!e.has_db_key) {
      return err({
        kind: "HandlerError",
        operation: "ai_providers.propose_clear_key",
        message: `provider ${input.name} has no stored key to clear`,
      });
    }
    const preview = {
      kind: "clear_key",
      name: e.name,
      displayName: e.display_name,
      isActive: e.is_active,
    };
    return queueProposal(
      tx,
      ctx,
      "clear_key",
      input.name,
      input,
      preview,
      "ai_providers.propose_clear_key",
    );
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeAiProvidersProposalOp = defineOperation({
  name: "ai_providers.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      // Owner-supplied secret. Required for `set` proposals when no
      // existing key was present; optional when the proposal is
      // editing an existing provider that already has a key. Ignored
      // for `clear_key` proposals.
      apiKey: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({ apiKeyChanged: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, provider_name, payload, status
      FROM ai_providers_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "set" | "clear_key";
      provider_name: string;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "ai_providers.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "ai_providers.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    let apiKeyChanged = false;
    if (row.kind === "set") {
      const payload = parsePayload<z.infer<typeof proposeSetInput>>(row.payload);
      const r = await setAiProvidersOp.handler(
        ctx,
        // Only attach apiKey when the Owner actually supplied one;
        // setAiProvidersOp preserves the existing encrypted blob when
        // apiKey is absent.
        input.apiKey !== undefined
          ? {
              ...payload,
              config: payload.config ?? {},
              isActive: payload.isActive ?? true,
              apiKey: input.apiKey,
            }
          : { ...payload, config: payload.config ?? {}, isActive: payload.isActive ?? true },
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "set");
      apiKeyChanged = (r.value as { apiKeyChanged: boolean }).apiKeyChanged;
    } else if (row.kind === "clear_key") {
      const r = await clearAiProviderKeyOp.handler(
        ctx,
        parsePayload<Parameters<typeof clearAiProviderKeyOp.handler>[1]>(row.payload),
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "clear_key");
      apiKeyChanged = (r.value as { cleared: boolean }).cleared;
    }
    await tx.execute(sql`
      UPDATE ai_providers_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_providers.execute_proposal",
      // Strip the apiKey from the audit input.
      input: {
        proposalId: input.proposalId,
        apiKeyProvided: input.apiKey !== undefined,
      },
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (provider=${row.provider_name})`,
    });
    return ok({ apiKeyChanged });
  },
});

export const rejectAiProvidersProposalOp = defineOperation({
  name: "ai_providers.reject_proposal",
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
      UPDATE ai_providers_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_providers.reject_proposal",
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
  kind: z.enum(["set", "clear_key"]),
  proposedBy: z.string(),
  providerName: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingAiProvidersProposalsOp = defineOperation({
  name: "ai_providers.list_pending",
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
        provider_name, payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM ai_providers_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "set" | "clear_key";
      proposed_by: string;
      provider_name: string;
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
        kind: r.kind,
        proposedBy: r.proposed_by,
        providerName: r.provider_name,
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
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "set" | "clear_key",
  providerName: string,
  payload: unknown,
  preview: unknown,
  opName: string,
): Promise<
  | {
      ok: true;
      value: { proposalId: string; preview: Record<string, unknown>; requiresSecrets?: string[] };
    }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const payloadHash = await hashProposalPayload(payload);
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO ai_providers_pending_actions
        (kind, proposed_by, provider_name, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${providerName},
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
      return err({ kind: "HandlerError", operation: opName, message: DUPLICATE_PROPOSAL_MESSAGE });
    }
    throw e;
  }
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
    resultSummary: `kind=${kind} provider=${providerName}`,
  });
  const previewObj = preview as Record<string, unknown>;
  const requiresSecrets = Array.isArray(previewObj.requiresSecrets)
    ? (previewObj.requiresSecrets as string[])
    : [];
  return ok({ proposalId, preview: previewObj, requiresSecrets });
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
    operation: "ai_providers.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}
