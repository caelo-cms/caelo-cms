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
 *   cap are checked under one lock, so concurrent requests cannot both
 *   pass. The reservation is an `ai_calls` row at the maximum cost.
 * - An uncertain outcome keeps its reservation and is never retried
 *   automatically: retrying would pay twice.
 * - Provenance is recorded at reservation (operation, prompt, references,
 *   mask, what was requested, provider/model).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

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

const LEDGER_LOCK = sql`SELECT pg_advisory_xact_lock(220, 1)`;

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
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    id: row.id,
    scope: row.scope,
    inputSha256: row.input_sha256,
    operation: row.operation,
    prompt: row.prompt,
    references: (json(row.references_json) as unknown[]) ?? [],
    mask: json(row.mask_json) ?? null,
    requested: (json(row.requested) as Record<string, unknown>) ?? {},
    provider: row.provider,
    model: row.model,
    status: row.status,
    result: json(row.result) ?? null,
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
  await tx.execute(LEDGER_LOCK);
  const existing = await readImageRequest(tx, input.scope, input.requestId);
  if (existing) {
    if (existing.inputSha256 !== input.inputSha256) return { refused: { kind: "conflict" } };
    return { existing };
  }
  // Per-session caps: a chat session id, or (plugins) the chat-branch tag.
  const sessionCondition = input.chatSessionId
    ? sql`AND chat_session_id = ${input.chatSessionId}::uuid`
    : input.sessionTag
      ? sql`AND request_id = ${input.sessionTag}`
      : null;
  const budgets = (await tx.execute(sql`
    SELECT scope, cap_microcents FROM ai_budgets
    WHERE operation_type = 'image' AND cap_microcents IS NOT NULL
  `)) as unknown as { scope: string; cap_microcents: string }[];
  for (const budget of budgets) {
    if (budget.scope === "session" && !sessionCondition) {
      return { refused: { kind: "session-required" } };
    }
    const scoped =
      budget.scope === "day-per-actor"
        ? sql`AND actor_id = ${input.actorId}::uuid`
        : budget.scope === "session"
          ? (sessionCondition ?? sql``)
          : sql``;
    const since =
      budget.scope === "session" ? sql`` : sql`AND created_at > now() - interval '24 hours'`;
    const usage = (await tx.execute(sql`
      SELECT coalesce(sum(cost_estimate_microcents), 0)::bigint AS spent FROM ai_calls
      WHERE operation_type = 'image' ${since} ${scoped}
    `)) as unknown as { spent: string }[];
    if (Number(usage[0]?.spent ?? 0) + input.maxCostMicrocents > Number(budget.cap_microcents)) {
      return { refused: { kind: "budget", scope: budget.scope } };
    }
  }
  if (input.pluginId) {
    const plugin = (await tx.execute(sql`
      SELECT p.ai_cost_cap_microcents AS cap,
             coalesce((SELECT sum(cost_estimate_microcents) FROM ai_calls
                       WHERE plugin_id = p.id AND created_at > now() - interval '24 hours'), 0)::bigint AS spent
      FROM plugins p WHERE p.id = ${input.pluginId}::uuid
    `)) as unknown as { cap: string | null; spent: string }[];
    const cap = plugin[0]?.cap;
    if (cap !== null && cap !== undefined) {
      if (Number(plugin[0]?.spent) + input.maxCostMicrocents > Number(cap)) {
        return { refused: { kind: "plugin-budget" } };
      }
    }
  }
  const callId = crypto.randomUUID();
  await tx.execute(sql`
    INSERT INTO ai_calls (id, actor_id, plugin_id, chat_session_id, provider, model,
      input_tokens, output_tokens, cached_tokens, cost_estimate_microcents, succeeded,
      operation_type, image_count, request_id)
    VALUES (${callId}::uuid, ${input.actorId}::uuid, ${input.pluginId ?? null}::uuid,
      ${input.chatSessionId ?? null}::uuid, ${input.provider}, ${input.model}, 0, 0, 0,
      ${input.maxCostMicrocents}, false, 'image', 1, ${input.sessionTag ?? input.scope})
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
      duration_ms = ${input.durationMs}, succeeded = true
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
