// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "../password.js";

/**
 * First-run owner bootstrap. Succeeds only when zero users exist; any
 * subsequent call returns `Err('HandlerError')`. Creates the `actors` row
 * first, then the `users` row linked to it, then assigns the built-in
 * `owner` role.
 */
export const createFirstOwnerOp = defineOperation({
  name: "users.create_first_owner",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(256),
    displayName: z.string().min(1).max(128),
  }),
  output: z.object({ userId: z.string() }),
  handler: async (_ctx, input, tx) => {
    const existing = (await tx.execute(sql`SELECT 1 AS exists FROM users LIMIT 1`)) as unknown as {
      exists: number;
    }[];
    if (existing.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: "setup already complete",
      });
    }

    const passwordHash = await hashPassword(input.password);

    const actorRows = (await tx.execute(sql`
      INSERT INTO actors (kind, display_name)
      VALUES ('human', ${input.displayName})
      RETURNING id
    `)) as unknown as { id: string }[];
    const actorId = actorRows[0]?.id;
    if (!actorId) {
      return err({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: "actor insert returned no row",
      });
    }

    await tx.execute(sql`
      INSERT INTO users (id, email, password_hash, is_first_owner)
      VALUES (${actorId}::uuid, ${input.email}, ${passwordHash}, true)
    `);

    await tx.execute(sql`
      INSERT INTO user_roles (user_id, role_id)
      SELECT ${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
    `);

    return ok({ userId: actorId });
  },
});

/**
 * Read-only flag used by the `/setup` route to decide whether to render the
 * owner-creation form or redirect to `/login`.
 */
export const isSetupCompleteOp = defineOperation({
  name: "users.is_setup_complete",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ complete: z.boolean() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT EXISTS(SELECT 1 FROM users) AS complete`,
    )) as unknown as { complete: boolean }[];
    return ok({ complete: rows[0]?.complete ?? false });
  },
});
