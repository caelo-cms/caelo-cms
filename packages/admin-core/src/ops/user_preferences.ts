// SPDX-License-Identifier: MPL-2.0

/**
 * Per-user jsonb key/value store. P6.7 uses it for the live-edit
 * overlay's `edit_overlay_layout` (floating/pinned/collapsed state +
 * position + size). RLS at the table level limits each user to their
 * own row — the ops simply scope by `ctx.actorId` and trust the
 * policy.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { jsonbParam } from "../sql-helpers.js";

const keyShape = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

export const getUserPreferenceOp = defineOperation({
  name: "user_preferences.get",
  // Why human-only: Per-user UI state; AI uses chat session memory + chips instead.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ key: keyShape }).strict(),
  output: z.object({ value: z.unknown().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT value FROM user_preferences
      WHERE user_id = ${ctx.actorId}::uuid AND key = ${input.key}
      LIMIT 1
    `)) as unknown as { value: unknown }[];
    const r = rows[0];
    if (!r) return ok({ value: null });
    return ok({
      value: typeof r.value === "string" ? JSON.parse(r.value) : r.value,
    });
  },
});

export const setUserPreferenceOp = defineOperation({
  name: "user_preferences.set",
  // Why human-only: Per-user UI state; AI uses chat session memory + chips instead.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      key: keyShape,
      value: z.unknown(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    if (input.value === undefined) {
      return err({
        kind: "HandlerError",
        operation: "user_preferences.set",
        message: "value cannot be undefined",
      });
    }
    await tx.execute(sql`
      INSERT INTO user_preferences (user_id, key, value, updated_at)
      VALUES (
        ${ctx.actorId}::uuid,
        ${input.key},
        ${jsonbParam(input.value)},
        now()
      )
      ON CONFLICT (user_id, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
    `);
    return ok({});
  },
});
