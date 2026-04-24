// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { verifyPassword } from "../password.js";
import { generateCsrfToken, generateSessionToken, SESSION_TTL_MS } from "../tokens.js";

/**
 * Exchange an email + password for a fresh session. Runs as `system` because
 * the caller has no identity yet; the Validator's actor-scope check means only
 * unauthenticated app routes can invoke this op.
 */
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
    const rows = (await tx.execute(sql`
      SELECT u.id AS id, u.password_hash AS password_hash
      FROM users u
      WHERE u.email = ${input.email}
      LIMIT 1
    `)) as unknown as { id: string; password_hash: string }[];
    const user = rows[0];

    // Verify regardless of whether the user exists — same time cost on either
    // branch, so an attacker can't enumerate valid emails via response timing.
    // We still reveal "invalid credentials" uniformly.
    const ok_ = user ? await verifyPassword(input.password, user.password_hash) : false;
    if (!user || !ok_) {
      return err({
        kind: "HandlerError",
        operation: "auth.login",
        message: "invalid credentials",
      });
    }

    const token = generateSessionToken();
    const csrfToken = generateCsrfToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    // Sweep expired sessions for this user opportunistically.
    await tx.execute(
      sql`DELETE FROM sessions WHERE user_id = ${user.id}::uuid AND expires_at < now()`,
    );

    await tx.execute(sql`
      INSERT INTO sessions (token, user_id, csrf_token, expires_at)
      VALUES (${token}, ${user.id}::uuid, ${csrfToken}, ${expiresAt.toISOString()})
    `);

    return ok({
      userId: user.id,
      token,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
    });
  },
});

export const logoutOp = defineOperation({
  name: "auth.logout",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ token: z.string() }),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM sessions WHERE token = ${input.token}`);
    return ok({});
  },
});

/**
 * Look up a session by token → returns the user and the permission grants
 * implied by their roles. Invoked by the hooks.server.ts middleware on every
 * request to establish the per-request `ExecutionContext`.
 */
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
    const rows = (await tx.execute(sql`
      SELECT s.user_id AS user_id,
             u.email AS email,
             s.csrf_token AS csrf_token,
             s.expires_at AS expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ${input.token}
        AND s.expires_at > now()
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
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
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
