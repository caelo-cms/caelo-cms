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
  // Why system-only: authentication itself: runs before any actor is resolved (the credential in
  // the input is the identity); the AI never authenticates as a user.
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
  // Why system-only: maps a session cookie to an actor on every request, before any actor exists.
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
  // Why system-only: unauthenticated self-service reset (see the doc comment above); the AI
  // never handles credentials or reset tokens.
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

    const { token } = await issueResetToken(tx, user.id);
    return ok({
      delivery: { email: input.email, token, displayName: user.display_name },
    });
  },
});

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/**
 * Store a fresh one-hour reset token for `userId` (only its SHA-256 lands in
 * `password_reset_tokens`) and return the raw token for the caller to deliver.
 * Also the set-password link a credential handoff emails a new user (#971).
 */
export async function issueResetToken(
  tx: Tx,
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await tx.execute(sql`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}::uuid, ${hashResetToken(token)}, ${expiresAt})
  `);
  return { token, expiresAt };
}

/**
 * Account recovery for whoever runs the install's cloud account: issue a reset
 * token for an Owner and hand it back to the caller, which is the internal
 * endpoint `cms-provision owner-reset` calls through the admin's identity
 * proxy. That caller already holds the install's internal secret and can
 * reach its database and deploys, so the token grants it nothing it could
 * not take anyway. It is the recovery path for installs without an email
 * transport, where `/forgot` cannot deliver a link.
 *
 * Without `email` the token is for the install's only Owner. With several
 * Owners the call fails and names them, so the operator picks with `--email`.
 * An email that is not an Owner fails too: the command recovers Owner access,
 * the other accounts are reset by an Owner under Settings -> Users.
 */
export const issueOwnerResetOp = defineOperation({
  name: "auth.issue_owner_reset",
  // Why system-only: it hands a raw credential to infrastructure tooling that
  // authenticated at the HTTP boundary (internal token + identity proxy); no
  // user or AI session ever reaches it.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({
    email: z.string().email().max(254).optional(),
    // Who asked, for the audit row: the endpoint puts the CLI's self-asserted
    // gcloud account (≤320 chars, room for a workforce principal) in here
    // next to the command name.
    source: z.string().min(1).max(400),
  }),
  output: z.object({ email: z.string(), token: z.string(), expiresAt: z.string() }),
  handler: async (ctx, input, tx) => {
    const owners = (await tx.execute(sql`
      SELECT u.id::text AS id, u.email AS email
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'owner' AND u.deleted_at IS NULL
      ORDER BY u.email
    `)) as unknown as { id: string; email: string }[];
    const picked = pickOwnerToReset(owners, input.email);
    if (!picked.ok) {
      await recordAudit(tx, {
        actorId: SYSTEM_ACTOR_ID,
        requestId: ctx.requestId,
        operation: "auth.issue_owner_reset",
        input,
        succeeded: false,
        resultSummary: picked.summary,
      });
      return err({
        kind: "HandlerError",
        operation: "auth.issue_owner_reset",
        message: picked.message,
      });
    }
    const owner = picked.owner;

    const issued = await issueResetToken(tx, owner.id);
    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "auth.issue_owner_reset",
      input,
      succeeded: true,
      entityId: owner.id,
      resultSummary: `issued via ${input.source}`,
    });
    return ok({ email: owner.email, ...issued });
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
  // Why system-only: unauthenticated token redemption (see the doc comment above); the AI never
  // handles credentials or reset tokens.
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
    // A reset invalidates every existing session and MCP credential for the account.
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${row.user_id}::uuid`);
    await tx.execute(sql`
      UPDATE mcp_tokens SET revoked_at = now()
      WHERE actor_id = ${row.user_id}::uuid AND revoked_at IS NULL
    `);
    await tx.execute(sql`
      UPDATE mcp_remote_connections SET revoked_at = now()
      WHERE actor_id = ${row.user_id}::uuid AND revoked_at IS NULL
    `);

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

/** Who `auth.issue_owner_reset` resets, or why it refuses (summary = audit tag). */
export type OwnerPick =
  | { ok: true; owner: { id: string; email: string } }
  | { ok: false; summary: string; message: string };

/**
 * Pick the Owner account to reset: the named one (case-insensitive), or the
 * only Owner when none is named. Pure, so the refusal messages are unit-tested.
 */
export function pickOwnerToReset(
  owners: readonly { id: string; email: string }[],
  email: string | undefined,
): OwnerPick {
  const noOwner =
    "This install has no Owner account yet. Finish the first-run setup at /setup instead.";
  const ownerList = owners.map((o) => o.email).join(", ");
  if (email !== undefined) {
    const wanted = email.toLowerCase();
    const owner = owners.find((o) => o.email.toLowerCase() === wanted);
    if (owner) return { ok: true, owner };
    return {
      ok: false,
      summary: "not-an-owner",
      message:
        owners.length === 0
          ? noOwner
          : `${email} is not an Owner of this install. Owners: ${ownerList}. Other accounts are reset by an Owner under Settings -> Users.`,
    };
  }
  const only = owners.length === 1 ? owners[0] : undefined;
  if (only) return { ok: true, owner: only };
  return owners.length === 0
    ? { ok: false, summary: "no-owner", message: noOwner }
    : {
        ok: false,
        summary: "several-owners",
        message: `This install has ${owners.length} Owners (${ownerList}). Name the one to reset with --email <address>.`,
      };
}
