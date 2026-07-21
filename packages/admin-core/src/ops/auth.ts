// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../audit.js";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../password.js";
import {
  generateCsrfToken,
  generateResetToken,
  generateSessionToken,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
  SESSION_TTL_MS,
} from "../tokens.js";

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
  handler: async (ctx, input, tx) => {
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
        requestId: ctx.requestId,
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
      requestId: ctx.requestId,
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
  // Why human-only: session boundary; AI never logs anyone out.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ token: z.string() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM sessions WHERE token = ${input.token}`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
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
    /** P6.6b — `null` means the user hasn't completed the first-login
     *  onboarding tour; layout server-load redirects them to /onboarding. */
    onboardedAt: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    // Soft-deleted users have their sessions wiped at delete time, but a stale
    // token with a soft-deleted owner must still be rejected here.
    const rows = (await tx.execute(sql`
      SELECT s.user_id::text AS user_id,
             u.email AS email,
             s.csrf_token AS csrf_token,
             s.expires_at AS expires_at,
             u.onboarded_at AS onboarded_at
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
      onboarded_at: string | Date | null;
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
      onboardedAt:
        row.onboarded_at === null
          ? null
          : row.onboarded_at instanceof Date
            ? row.onboarded_at.toISOString()
            : String(row.onboarded_at),
    });
  },
});

/**
 * Step 1 of self-service reset: issue a one-hour, single-use reset token for the
 * account with this email and hand the RAW token back to the caller (the route)
 * to email as a `/reset?token=…` link. Unauthenticated, so it runs as system
 * (the system bypass is what lets it read the user + write the token row).
 *
 * No account enumeration: `delivery` is null when no account matches, and the
 * route shows the SAME "if that address exists, we sent a link" message either
 * way. We store only the SHA-256 of the token (see `password_reset_tokens`).
 */
export const requestPasswordResetOp = defineOperation({
  name: "auth.request_password_reset",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ email: z.string().email().max(254) }),
  output: z.object({
    delivery: z
      .object({ email: z.string(), token: z.string(), displayName: z.string() })
      .nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT u.id::text AS id, a.display_name AS display_name
      FROM users u JOIN actors a ON a.id = u.id
      WHERE u.email = ${input.email} AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { id: string; display_name: string }[];
    const user = rows[0];

    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "auth.request_password_reset",
      input,
      succeeded: true,
      // Never leak whether the address matched an account.
      resultSummary: user ? "issued" : "no-account",
    });

    if (!user) return ok({ delivery: null });

    const rawToken = generateResetToken();
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await tx.execute(sql`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${user.id}::uuid, ${tokenHash}, ${expiresAt.toISOString()})
    `);

    return ok({
      delivery: { email: input.email, token: rawToken, displayName: user.display_name },
    });
  },
});

/**
 * Step 2 of self-service reset: redeem a token and set the new password. The
 * presented token IS the proof of identity, so this runs unauthenticated (as
 * system). The token must be unused + unexpired; on success it is burned along
 * with every other outstanding token for the user, and ALL of the user's
 * sessions are revoked (the account may have been compromised).
 */
export const resetPasswordOp = defineOperation({
  name: "auth.reset_password",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({
    token: z.string().min(1).max(512),
    newPassword: z.string().min(1).max(256),
  }),
  output: z.object({ email: z.string() }),
  handler: async (ctx, input, tx) => {
    const tokenHash = hashResetToken(input.token);
    const rows = (await tx.execute(sql`
      SELECT t.id::text AS token_id, u.id::text AS user_id, u.email AS email,
             a.display_name AS display_name
      FROM password_reset_tokens t
      JOIN users u ON u.id = t.user_id
      JOIN actors a ON a.id = u.id
      WHERE t.token_hash = ${tokenHash}
        AND t.used_at IS NULL
        AND t.expires_at > now()
        AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as {
      token_id: string;
      user_id: string;
      email: string;
      display_name: string;
    }[];
    const row = rows[0];
    if (!row) {
      await recordAudit(tx, {
        actorId: SYSTEM_ACTOR_ID,
        requestId: ctx.requestId,
        operation: "auth.reset_password",
        input,
        succeeded: false,
        resultSummary: "invalid-or-expired-token",
      });
      return err({
        kind: "HandlerError",
        operation: "auth.reset_password",
        message: "This reset link is invalid or has expired. Request a new one.",
      });
    }

    const strength = validatePasswordStrength(input.newPassword, {
      email: row.email,
      displayName: row.display_name,
    });
    if (!strength.ok) {
      return err({
        kind: "HandlerError",
        operation: "auth.reset_password",
        message: strength.reason,
      });
    }

    const newHash = await hashPassword(input.newPassword);
    await tx.execute(
      sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${row.user_id}::uuid`,
    );
    // One-shot: burn this token AND supersede every other outstanding one.
    await tx.execute(
      sql`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${row.token_id}::uuid`,
    );
    await tx.execute(
      sql`DELETE FROM password_reset_tokens WHERE user_id = ${row.user_id}::uuid AND used_at IS NULL`,
    );
    // A reset invalidates every existing session for the account.
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${row.user_id}::uuid`);

    await recordAudit(tx, {
      actorId: row.user_id,
      requestId: ctx.requestId,
      operation: "auth.reset_password",
      input,
      succeeded: true,
      entityId: row.user_id,
      resultSummary: "password-reset",
    });
    return ok({ email: row.email });
  },
});
