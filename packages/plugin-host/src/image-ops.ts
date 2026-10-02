// SPDX-License-Identifier: MPL-2.0

/**
 * Paid image generation for plugins, as named operations (CMS_REQUIREMENTS
 * §14.5 `image_generation`, §14.7). The host broker (images.ts) runs the
 * provider call itself; these operations hold the ledger around it:
 *
 * - `reserve` checks the plugin's `image_generation` receipt for exactly
 *   the running artifact (same check as private storage, in this
 *   transaction), every image budget and the plugin's own cost cap, then
 *   records the reservation in `ai_calls` and the request in
 *   `plugin_image_requests`. All reservations serialise, so concurrent
 *   requests cannot both pass a budget.
 * - `finish` / `mark_uncertain` settle it. An uncertain outcome keeps its
 *   reservation and is never retried automatically — retrying would pay
 *   twice; a new request id is a new, deliberate payment.
 * - `read` returns a request by id: the same id is idempotent.
 *
 * System-only: the ledger tables are host data under forced RLS. The
 * broker passes the plugin, artifact and operator it acts for.
 */

import {
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { privateGrantRefusal } from "./private-storage.js";

export const IMAGE_OPS = {
  read: "plugin_images.read",
  reserve: "plugin_images.reserve",
  finish: "plugin_images.finish",
  markUncertain: "plugin_images.mark_uncertain",
} as const;

const uuid = z.string().uuid();
const request = z.object({ pluginId: uuid, requestId: uuid }).strict();

const requestRow = z.object({
  id: z.string(),
  inputSha256: z.string(),
  model: z.string(),
  status: z.enum(["running", "ready", "uncertain"]),
  result: z.unknown().nullable(),
  costMicrocents: z.number(),
  createdAt: z.string(),
});
type RequestRow = z.infer<typeof requestRow>;

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

function fail(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message });
}

async function readRequest(
  tx: Tx,
  pluginId: string,
  requestId: string,
): Promise<RequestRow | null> {
  const rows = (await tx.execute(sql`
    SELECT r.id::text AS id, r.input_sha256, r.model, r.status, r.result,
           c.cost_estimate_microcents AS cost, r.created_at::text AS created_at
    FROM plugin_image_requests r JOIN ai_calls c ON c.id = r.call_id
    WHERE r.plugin_id = ${pluginId}::uuid AND r.id = ${requestId}::uuid
  `)) as unknown as {
    id: string;
    input_sha256: string;
    model: string;
    status: RequestRow["status"];
    result: unknown;
    cost: string | number;
    created_at: string;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    inputSha256: row.input_sha256,
    model: row.model,
    status: row.status,
    result: typeof row.result === "string" ? JSON.parse(row.result) : (row.result ?? null),
    costMicrocents: Number(row.cost),
    createdAt: row.created_at,
  };
}

const readOp = defineOperation({
  name: IMAGE_OPS.read,
  // Why system-only: host ledger; the broker reads on the plugin's behalf.
  actorScope: ["system"],
  database: "cms_admin",
  input: request,
  output: z.object({ request: requestRow.nullable() }),
  handler: async (_ctx, input, tx) =>
    ok({ request: await readRequest(tx, input.pluginId, input.requestId) }),
});

const reserveOp = defineOperation({
  name: IMAGE_OPS.reserve,
  // Why system-only: see read.
  actorScope: ["system"],
  database: "cms_admin",
  input: request
    .extend({
      pluginArtifactDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      model: z.string().min(1).max(200),
      maxCostMicrocents: z.number().int().min(1),
      operatorActorId: uuid,
      chatBranchId: uuid.optional(),
    })
    .strict(),
  output: z.object({ existing: requestRow.nullable(), callId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const op = IMAGE_OPS.reserve;
    // The grant check reads the plugin's own context: plugin + artifact.
    const pluginCtx: ExecutionContext = {
      ...ctx,
      pluginId: input.pluginId,
      ...(input.pluginArtifactDigest ? { pluginArtifactDigest: input.pluginArtifactDigest } : {}),
    };
    const refused = await privateGrantRefusal(tx, pluginCtx, "image_generation");
    if (refused) return fail(op, `${op}: ${refused}`);
    // Every plugin image reservation serialises against every other.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(220, 1)`);
    const existing = await readRequest(tx, input.pluginId, input.requestId);
    if (existing) {
      if (existing.inputSha256 !== input.inputSha256) {
        return fail(op, "PluginImageRequestConflict: this request id was used for another request");
      }
      return ok({ existing, callId: null });
    }
    const sessionTag = `plugin-images-chat:${input.chatBranchId ?? "none"}`;
    const budgets = (await tx.execute(sql`
      SELECT scope, cap_microcents FROM ai_budgets
      WHERE operation_type = 'image' AND cap_microcents IS NOT NULL
    `)) as unknown as { scope: string; cap_microcents: string }[];
    for (const budget of budgets) {
      if (budget.scope === "session" && !input.chatBranchId) {
        return fail(op, "PluginImageSessionRequired: a per-session image budget needs a chat");
      }
      const scope =
        budget.scope === "day-per-actor"
          ? sql`AND actor_id = ${input.operatorActorId}::uuid`
          : budget.scope === "session"
            ? sql`AND request_id = ${sessionTag}`
            : sql``;
      const since =
        budget.scope === "session" ? sql`` : sql`AND created_at > now() - interval '24 hours'`;
      const usage = (await tx.execute(sql`
        SELECT coalesce(sum(cost_estimate_microcents), 0)::bigint AS spent FROM ai_calls
        WHERE operation_type = 'image' ${since} ${scope}
      `)) as unknown as { spent: string }[];
      if (Number(usage[0]?.spent ?? 0) + input.maxCostMicrocents > Number(budget.cap_microcents)) {
        return fail(op, `PluginImageBudgetExceeded:${budget.scope}`);
      }
    }
    const pluginBudget = (await tx.execute(sql`
      SELECT p.ai_cost_cap_microcents AS cap,
             coalesce((SELECT sum(cost_estimate_microcents) FROM ai_calls
                       WHERE plugin_id = p.id AND created_at > now() - interval '24 hours'), 0)::bigint AS spent
      FROM plugins p WHERE p.id = ${input.pluginId}::uuid
    `)) as unknown as { cap: string | null; spent: string }[];
    const cap = pluginBudget[0]?.cap;
    if (cap !== null && cap !== undefined) {
      if (Number(pluginBudget[0]?.spent) + input.maxCostMicrocents > Number(cap)) {
        return fail(op, "PluginImagePluginBudgetExceeded");
      }
    }
    const callId = crypto.randomUUID();
    await tx.execute(sql`
      INSERT INTO ai_calls (id, actor_id, plugin_id, provider, model, input_tokens, output_tokens,
        cached_tokens, cost_estimate_microcents, succeeded, operation_type, image_count, request_id)
      VALUES (${callId}::uuid, ${input.operatorActorId}::uuid, ${input.pluginId}::uuid, 'google',
        ${input.model}, 0, 0, 0, ${input.maxCostMicrocents}, false, 'image', 1, ${sessionTag})
    `);
    await tx.execute(sql`
      INSERT INTO plugin_image_requests (plugin_id, id, input_sha256, call_id, model, status)
      VALUES (${input.pluginId}::uuid, ${input.requestId}::uuid, ${input.inputSha256},
        ${callId}::uuid, ${input.model}, 'running')
    `);
    return ok({ existing: null, callId });
  },
});

const finishOp = defineOperation({
  name: IMAGE_OPS.finish,
  // Why system-only: see read.
  actorScope: ["system"],
  database: "cms_admin",
  input: request
    .extend({
      callId: uuid,
      result: z.record(z.string(), z.unknown()),
      costMicrocents: z.number().int().min(0),
      durationMs: z.number().int().min(0),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE plugin_image_requests SET status = 'ready', result = ${sql.param(input.result)}
      WHERE plugin_id = ${input.pluginId}::uuid AND id = ${input.requestId}::uuid
    `);
    await tx.execute(sql`
      UPDATE ai_calls SET cost_estimate_microcents = ${input.costMicrocents},
        duration_ms = ${input.durationMs}, succeeded = true
      WHERE id = ${input.callId}::uuid
    `);
    return ok({});
  },
});

const markUncertainOp = defineOperation({
  name: IMAGE_OPS.markUncertain,
  // Why system-only: see read.
  actorScope: ["system"],
  database: "cms_admin",
  input: request,
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE plugin_image_requests SET status = 'uncertain'
      WHERE plugin_id = ${input.pluginId}::uuid AND id = ${input.requestId}::uuid
    `);
    return ok({});
  },
});

const ALL = [readOp, reserveOp, finishOp, markUncertainOp];

/** Register the image ledger operations (idempotent, like the storage ops). */
export function registerPluginImageOps(registry: OperationRegistry): void {
  if (registry.has(IMAGE_OPS.read)) return;
  // The registry stores every op as OperationDefinition<unknown, unknown>.
  for (const op of ALL) registry.register(op as OperationDefinition<unknown, unknown>);
}
