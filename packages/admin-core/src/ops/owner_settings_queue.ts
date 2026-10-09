// SPDX-License-Identifier: MPL-2.0

/**
 * The shared half of the `owner_settings` §11.A gate: the kind enum and the
 * pending-row insert every `owner_settings.propose_*` op goes through. Split
 * out of `owner_settings_pending.ts` so the gate's propose ops can live in
 * more than one file (`owner_settings_security.ts` holds the plugin AI cap,
 * rate-limit profile and cookie-secret ones) while
 * `owner_settings.execute_proposal` stays the single apply step.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";

export type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Every action the owner-settings gate can apply (migration 0244 CHECK). */
export const ownerSettingsKind = z.enum([
  "set_ai_budget",
  "set_ai_pricing",
  "set_gateway_settings",
  "set_translation_model",
  "set_plugin_ai_cost_cap",
  "rotate_gateway_cookie_secret",
]);
export type OwnerSettingsKind = z.infer<typeof ownerSettingsKind>;

/** Output of every `owner_settings.propose_*` op. */
export const proposeOutput = z.object({
  proposalId: z.string(),
  preview: z.record(z.string(), z.unknown()),
});

/** A HandlerError result for `operation`. */
export function handlerError(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message });
}

/** The `message` of an op error value, for wrapping it in another op's error. */
export function errorMessage(e: unknown): string {
  return typeof e === "object" && e && "message" in e
    ? String((e as { message: unknown }).message)
    : "unknown";
}

/**
 * Insert one pending owner-settings proposal (deduplicated on the payload
 * while pending), audit it, and return `{ proposalId, preview }`.
 */
export async function queueProposal(
  tx: Tx,
  ctx: ExecutionContext,
  kind: OwnerSettingsKind,
  payload: unknown,
  preview: Record<string, unknown>,
  opName: string,
  summary: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const payloadHash = await hashProposalPayload({ kind, payload });
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO owner_settings_pending_actions
        (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
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
      return handlerError(opName, DUPLICATE_PROPOSAL_MESSAGE);
    }
    throw e;
  }
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return handlerError(opName, "insert returned no id");
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: payload,
    succeeded: true,
    entityId: proposalId,
    resultSummary: summary,
  });
  return ok({ proposalId, preview });
}
