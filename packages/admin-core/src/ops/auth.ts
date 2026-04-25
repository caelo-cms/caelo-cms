// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../audit.js";
import { verifyPassword } from "../password.js";
import { generateCsrfToken, generateSessionToken, SESSION_TTL_MS } from "../tokens.js";

export const loginOp = defineOperation({
  name: "auth.login",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ email: z.string().email(), password: z.string().min(1).max(256) }),
  output: z.object({
    userId: z.string(),
    token: z.string(),
    csrfToken: z.string(),
    expiresAt: z.string(),
  }),
  handler: async (_ctx, input, tx) => {
    // Soft-deleted users cannot log in.
    const rows = (await tx.execute(sql`
      SELECT u.id::text AS id, u.password_hash AS password_hash
      FROM users u
      WHERE u.email = ${input.email} AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { id: string; password_hash: string }[];
    const user = rows[0];

    const passwordOk = user ? await verifyPassword(input.password, user.password_hash) : false;

    if (!user || !passwordOk) {
      await recordAudit(tx, {
        actorId: SYSTEM_ACTOR_ID,
        operation: "auth.login",
        input,
        succeeded: false,
        // No email or password fingerprint here — leaking either weakens
        // the credential-stuffing protection from constant-time matching.
        resultSummary: user ? "wrong-password" : "no-such-user",
      });
      return err({
        kind: "HandlerError",
        operation: "auth.login",
        message: "invalid credentials",
      });
    }

    const token = generateSessionToken();
    const csrfToken = generateCsrfToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await tx.execute(
      sql`DELETE FROM sessions WHERE user_id = ${user.id}::uuid AND expires_at < now()`,
    );
    await tx.execute(sql`
      INSERT INTO sessions (token, user_id, csrf_token, expires_at)
      VALUES (${token}, ${user.id}::uuid, ${csrfToken}, ${expiresAt.toISOString()})
    `);

    await recordAudit(tx, {
      actorId: user.id,
      operation: "auth.login",
      input,
      succeeded: true,
      entityId: user.id,
      // Record only the last 8 chars of the session token so two distinct
      // logins with the same email don't collide on input_hash.
      resultSummary: `token=…${token.slice(-8)}`,
    });

    return ok({ userId: user.id, token, csrfToken, expiresAt: expiresAt.toISOString() });
  },
});

export const logoutOp = defineOperation({
  name: "auth.logout",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ token: z.string() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM sessions WHERE token = ${input.token}`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "auth.logout",
      input,
      succeeded: true,
      entityId: ctx.actorId,
      resultSummary: `token=…${input.token.slice(-8)}`,
    });
    return ok({});
  },
});

export const resolveSessionOp = defineOperation({
  name: "auth.resolve_session",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ token: z.string() }),
  output: z.object({
    userId: z.string(),
    email: z.string(),
    csrfToken: z.string(),
    expiresAt: z.string(),
    permissions: z.array(z.string()),
    roles: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    // Soft-deleted users have their sessions wiped at delete time, but a stale
    // token with a soft-deleted owner must still be rejected here.
    const rows = (await tx.execute(sql`
      SELECT s.user_id::text AS user_id,
             u.email AS email,
             s.csrf_token AS csrf_token,
             s.expires_at AS expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ${input.token}
        AND s.expires_at > now()
        AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as {
      user_id: string;
      email: string;
      csrf_token: string;
      expires_at: string | Date;
    }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "auth.resolve_session",
        message: "invalid or expired session",
      });
    }

    const permRows = (await tx.execute(sql`
      SELECT DISTINCT p.name AS name
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ${row.user_id}::uuid
    `)) as unknown as { name: string }[];

    const roleRows = (await tx.execute(sql`
      SELECT r.name AS name
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ${row.user_id}::uuid
    `)) as unknown as { name: string }[];

    return ok({
      userId: row.user_id,
      email: row.email,
      csrfToken: row.csrf_token,
      expiresAt:
        row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      permissions: permRows.map((r) => r.name),
      roles: roleRows.map((r) => r.name),
    });
  },
});
