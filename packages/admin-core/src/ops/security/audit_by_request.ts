// SPDX-License-Identifier: MPL-2.0

/**
 * P16 hardening — list every audit_events + ai_calls row for one
 * request_id. The Owner can land on /security/audit/<requestId> from
 * a structured-log line or an X-Caelo-Request-Id response header and
 * see the full trail of writes that one HTTP request produced.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const auditRow = z.object({
  id: z.string(),
  actorId: z.string(),
  operation: z.string(),
  succeeded: z.boolean(),
  entityId: z.string().nullable(),
  resultSummary: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  operationType: z.enum(["text", "image"]).nullable(),
  createdAt: z.string(),
});

const aiCallRow = z.object({
  id: z.string(),
  actorId: z.string(),
  provider: z.string(),
  model: z.string(),
  operationType: z.enum(["text", "image"]),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costMicrocents: z.number().int().nonnegative(),
  succeeded: z.boolean(),
  pluginId: z.string().nullable(),
  createdAt: z.string(),
});

export const auditByRequestIdOp = defineOperation({
  name: "audit.by_request_id",
  // Owner debugging surface — Reviewers + Editors don't need it. Keep
  // the read scoped to settings.read at the route layer.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ requestId: z.string().min(1).max(64) }).strict(),
  output: z.object({
    audit: z.array(auditRow),
    aiCalls: z.array(aiCallRow),
  }),
  handler: async (_ctx, input, tx) => {
    const audit = (await tx.execute(sql`
      SELECT id::text AS id, actor_id::text AS actor_id, operation,
             succeeded, entity_id::text AS entity_id, result_summary,
             provider, model, operation_type,
             created_at
      FROM audit_events
      WHERE request_id = ${input.requestId}
      ORDER BY created_at ASC
      LIMIT 500
    `)) as unknown as Array<{
      id: string;
      actor_id: string;
      operation: string;
      succeeded: boolean;
      entity_id: string | null;
      result_summary: string | null;
      provider: string | null;
      model: string | null;
      operation_type: "text" | "image" | null;
      created_at: string | Date;
    }>;
    const aiCalls = (await tx.execute(sql`
      SELECT id::text AS id, actor_id::text AS actor_id, provider, model,
             operation_type, input_tokens, output_tokens,
             cost_estimate_microcents::bigint AS cost_microcents,
             succeeded, plugin_id::text AS plugin_id, created_at
      FROM ai_calls
      WHERE request_id = ${input.requestId}
      ORDER BY created_at ASC
      LIMIT 500
    `)) as unknown as Array<{
      id: string;
      actor_id: string;
      provider: string;
      model: string;
      operation_type: "text" | "image";
      input_tokens: number;
      output_tokens: number;
      cost_microcents: bigint | string | number;
      succeeded: boolean;
      plugin_id: string | null;
      created_at: string | Date;
    }>;
    const toN = (v: bigint | string | number): number =>
      typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number.parseInt(v, 10) : v;
    return ok({
      audit: audit.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        operation: r.operation,
        succeeded: r.succeeded,
        entityId: r.entity_id,
        resultSummary: r.result_summary,
        provider: r.provider,
        model: r.model,
        operationType: r.operation_type,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
      aiCalls: aiCalls.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        provider: r.provider,
        model: r.model,
        operationType: r.operation_type,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costMicrocents: toN(r.cost_microcents),
        succeeded: r.succeeded,
        pluginId: r.plugin_id,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});
