// SPDX-License-Identifier: MPL-2.0

/**
 * The one paid-image-request ledger (#527, #532), shared by chat and
 * plugins. Both callers wrap these functions in their own named Query API
 * operations (`plugin_images.*` in this package, `image_requests.*` in
 * admin-core); the functions run inside that operation's transaction.
 *
 * It lives in plugin-host because admin-core depends on plugin-host, not
 * the other way round — so this is the one place both can import.
 *
 * Guarantees, for every caller:
 * - A request id is unique inside its scope (`plugin:<id>` / `chat:<id>`).
 *   The same id with the same input returns the recorded request; with a
 *   different input it is refused.
 * - The budget is reserved before the paid call: every image `ai_budgets`
 *   cap (site, per actor, per session) and, for plugins, the plugin's own
 *   cap are checked under the one AI ledger lock (ai-ledger.ts, shared with
 *   text calls), so concurrent requests cannot both pass. The reservation
 *   is an `ai_calls` row at the maximum cost.
 * - An uncertain outcome keeps its reservation and is never retried
 *   automatically: retrying would pay twice.
 * - Provenance is recorded at reservation (operation, prompt, references,
 *   mask, what was requested, provider/model).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { AI_LEDGER_LOCK, checkAiCaps } from "./ai-ledger.js";

/** A recorded request, as callers read it back. */
export interface ImageRequestRecord {
  id: string;
  scope: string;
  inputSha256: string;
  operation: "generate" | "edit";
  prompt: string | null;
  references: unknown[];
  mask: unknown | null;
  requested: Record<string, unknown>;
  provider: string | null;
  model: string;
  status: "running" | "ready" | "uncertain";
  result: unknown | null;
  outputMediaId: string | null;
  costMicrocents: number;
  createdAt: string;
  finishedAt: string | null;
}

/** Everything a reservation records. */
export interface ImageReservation {
  scope: string;
  requestId: string;
  inputSha256: string;
  operation: "generate" | "edit";
  prompt: string;
  references: readonly { kind: string; id: string; sha256: string }[];
  mask?: { kind: string; id: string; sha256: string } | null;
  requested: Record<string, unknown>;
  provider: string;
  model: string;
  maxCostMicrocents: number;
  /** The human the request is made for (budgets per actor). */
  actorId: string;
  /** Plugin scope only: the plugin, whose own cap also applies. */
  pluginId?: string;
  /** Chat scope: the session (per-session budget, cost dashboard). */
  chatSessionId?: string;
  /** Plugin scope: per-session budgets key on the invoking chat branch. */
  sessionTag?: string;
}

/** Why a reservation was refused — callers turn this into their own error. */
export type ReservationRefusal =
  | { kind: "conflict" }
  | { kind: "session-required" }
  | { kind: "budget"; scope: string }
  | { kind: "plugin-budget" };

/** Read one request by scope + id, with its current cost. */
export async function readImageRequest(
  tx: TransactionRunner,
  scope: string,
  requestId: string,
): Promise<ImageRequestRecord | null> {
  const rows = (await tx.execute(sql`
    SELECT r.id::text AS id, r.scope, r.input_sha256, r.operation, r.prompt,
           r.references_json, r.mask_json, r.requested, r.provider, r.model,
           r.status, r.result, r.output_media_id::text AS output_media_id,
           c.cost_estimate_microcents AS cost,
           r.created_at::text AS created_at, r.finished_at::text AS finished_at
    FROM image_requests r JOIN ai_calls c ON c.id = r.call_id
    WHERE r.scope = ${scope} AND r.id = ${requestId}::uuid
  `)) as unknown as {
    id: string;
    scope: string;
    input_sha256: string;
    operation: "generate" | "edit";
    prompt: string | null;
    references_json: unknown;
    mask_json: unknown;
    requested: unknown;
    provider: string | null;
    model: string;
    status: ImageRequestRecord["status"];
    result: unknown;
    output_media_id: string | null;
    cost: string | number;
    created_at: string;
    finished_at: string | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    inputSha256: row.input_sha256,
    operation: row.operation,
    prompt: row.prompt,
    references: (row.references_json as unknown[]) ?? [],
    mask: row.mask_json ?? null,
    requested: (row.requested as Record<string, unknown>) ?? {},
    provider: row.provider,
    model: row.model,
    status: row.status,
    result: row.result ?? null,
    outputMediaId: row.output_media_id,
    costMicrocents: Number(row.cost),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Reserve budget and record the request. Returns the existing request for
 * a repeated id with the same input, a refusal, or the new reservation's
 * `ai_calls` id.
 */
export async function reserveImageRequest(
  tx: TransactionRunner,
  input: ImageReservation,
): Promise<
  { existing: ImageRequestRecord } | { refused: ReservationRefusal } | { callId: string }
> {
  // Every reservation, from every caller, serialises against every other.
  await tx.execute(AI_LEDGER_LOCK);
  const existing = await readImageRequest(tx, input.scope, input.requestId);
  if (existing) {
    if (existing.inputSha256 !== input.inputSha256) return { refused: { kind: "conflict" } };
    return { existing };
  }
  // Every cap (#1653's shared check): the image budgets, per session keyed
  // on the chat session or (plugins) the chat-branch tag, and the plugin's cap.
  const refused = await checkAiCaps(tx, {
    spender: input.pluginId
      ? {
          kind: "plugin",
          pluginId: input.pluginId,
          actorId: input.actorId,
          chatSessionId: input.chatSessionId ?? null,
        }
      : { kind: "actor", actorId: input.actorId, chatSessionId: input.chatSessionId ?? null },
    operationType: "image",
    amountMicrocents: input.maxCostMicrocents,
    session: input.chatSessionId
      ? { chatSessionId: input.chatSessionId }
      : input.sessionTag
        ? { tag: input.sessionTag }
        : null,
    requireSession: true,
  });
  if (refused) {
    if (refused.kind === "budget") return { refused: { kind: "budget", scope: refused.scope } };
    if (refused.kind === "session-required") return { refused: { kind: "session-required" } };
    return { refused: { kind: "plugin-budget" } };
  }
  const callId = crypto.randomUUID();
  await tx.execute(sql`
    INSERT INTO ai_calls (id, actor_id, plugin_id, chat_session_id, provider, model,
      input_tokens, output_tokens, cached_tokens, cost_estimate_microcents, succeeded,
      operation_type, image_count, request_id, spender, reservation)
    VALUES (${callId}::uuid, ${input.actorId}::uuid, ${input.pluginId ?? null}::uuid,
      ${input.chatSessionId ?? null}::uuid, ${input.provider}, ${input.model}, 0, 0, 0,
      ${input.maxCostMicrocents}, false, 'image', 1, ${input.sessionTag ?? input.scope},
      ${input.pluginId ? "plugin" : "actor"}, 'reserved')
  `);
  await tx.execute(sql`
    INSERT INTO image_requests (scope, id, plugin_id, chat_session_id, actor_id, input_sha256,
      call_id, operation, prompt, references_json, mask_json, requested, provider, model, status)
    VALUES (${input.scope}, ${input.requestId}::uuid, ${input.pluginId ?? null}::uuid,
      ${input.chatSessionId ?? null}::uuid, ${input.actorId}::uuid, ${input.inputSha256},
      ${callId}::uuid, ${input.operation}, ${input.prompt}, ${sql.param(input.references)},
      ${input.mask ? sql.param(input.mask) : null}, ${sql.param(input.requested)},
      ${input.provider}, ${input.model}, 'running')
  `);
  return { callId };
}

/** Settle a finished request at its actual cost. */
export async function finishImageRequest(
  tx: TransactionRunner,
  input: {
    scope: string;
    requestId: string;
    callId: string;
    result: Record<string, unknown>;
    outputMediaId?: string;
    costMicrocents: number;
    durationMs: number;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE image_requests SET status = 'ready', result = ${sql.param(input.result)},
      output_media_id = ${input.outputMediaId ?? null}::uuid, finished_at = now()
    WHERE scope = ${input.scope} AND id = ${input.requestId}::uuid
  `);
  await tx.execute(sql`
    UPDATE ai_calls SET cost_estimate_microcents = ${input.costMicrocents},
      duration_ms = ${input.durationMs}, succeeded = true, reservation = 'settled'
    WHERE id = ${input.callId}::uuid
  `);
}

/** Record an outcome we cannot confirm. The reservation stays charged. */
export async function markImageRequestUncertain(
  tx: TransactionRunner,
  scope: string,
  requestId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE image_requests SET status = 'uncertain', finished_at = now()
    WHERE scope = ${scope} AND id = ${requestId}::uuid
  `);
}
