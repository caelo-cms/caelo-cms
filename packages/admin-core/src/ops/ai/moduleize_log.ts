// SPDX-License-Identifier: MPL-2.0

/**
 * `ai_moduleize.log_attempt` — persist ONE `moduleize` run that needed a repair
 * (attempts >= 2) into `ai_moduleize_attempts`. Called by the add_module handler
 * from moduleize's `onRetry` callback so the block itself stays DB-free +
 * unit-testable. No raw SQL leaks out of this boundary (CLAUDE.md §2). Not
 * audited: this is internal AI telemetry (like ai_calls), not a user action.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { jsonbParam } from "../../sql-helpers.js";

const logModuleizeAttemptInput = z
  .object({
    chatSessionId: z.string().uuid().nullable().optional(),
    inputHtml: z.string(),
    fieldsHint: z.array(z.unknown()).nullable().optional(),
    attempts: z.number().int().min(2),
    errors: z.array(z.string()),
    outcome: z.enum(["ok_after_repair", "failed"]),
    finalFields: z.array(z.unknown()).nullable().optional(),
    model: z.string(),
    costMicrocents: z.number().int().min(0).default(0),
  })
  .strict();

export const logModuleizeAttemptOp = defineOperation({
  name: "ai_moduleize.log_attempt",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: logModuleizeAttemptInput,
  output: z.object({ id: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO ai_moduleize_attempts
        (chat_session_id, actor_id, input_html, fields_hint, attempts, errors,
         outcome, final_fields, model, cost_microcents)
      VALUES (
        ${input.chatSessionId ?? null}::uuid,
        ${ctx.actorId}::uuid,
        ${input.inputHtml},
        ${jsonbParam(input.fieldsHint ?? null)},
        ${input.attempts},
        ${jsonbParam(input.errors)},
        ${input.outcome},
        ${jsonbParam(input.finalFields ?? null)},
        ${input.model},
        ${input.costMicrocents}
      )
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    return ok({ id: rows[0]?.id ?? "" });
  },
});
