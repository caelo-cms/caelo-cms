// SPDX-License-Identifier: MPL-2.0

import { defineOperation, OperationAbortError, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../audit.js";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../password.js";
import { currentIdentityGate, identityGateMessage } from "../security/identity-gate.js";
import { withSystemRls } from "./_helpers.js";

/**
 * Create the first Owner (/setup). Once any bootstrap token was issued
 * (cms-provision ran), the call must redeem one — and redeems it in THIS
 * transaction, after every other check passed: a typo'd email, a weak
 * password or a lost race against another /setup must leave the single-use
 * token usable (PR #863, L-06). Redeeming it in a separate op first burned
 * it on any of those and stranded the install without a way to claim it.
 */
export const createFirstOwnerOp = defineOperation({
  name: "users.create_first_owner",
  // Why system-only: /setup mints the very first Owner before any session exists (bootstrap-token
  // gated); there is no actor yet to run it as.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(256),
    displayName: z.string().min(1).max(128),
    /** The `?token=` from the install output; required once any token was issued. */
    bootstrapToken: z.string().min(1).max(256).optional(),
  }),
  output: z.object({ userId: z.string() }),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(736578)`);

    const existing = (await tx.execute(
      sql`SELECT 1 AS exists FROM users WHERE deleted_at IS NULL LIMIT 1`,
    )) as unknown as { exists: number }[];
    if (existing.length > 0) {
      await recordAudit(tx, {
        actorId: SYSTEM_ACTOR_ID,
        requestId: ctx.requestId,
        operation: "users.create_first_owner",
        input,
        succeeded: false,
        resultSummary: "setup-already-complete",
      });
      return err({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: "setup already complete",
      });
    }

    const strength = validatePasswordStrength(input.password, {
      email: input.email,
      displayName: input.displayName,
    });
    if (!strength.ok) {
      await recordAudit(tx, {
        actorId: SYSTEM_ACTOR_ID,
        requestId: ctx.requestId,
        operation: "users.create_first_owner",
        input,
        succeeded: false,
        resultSummary: "weak-password",
      });
      return err({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: strength.reason,
      });
    }

    const tokenGate = await redeemBootstrapToken(tx, input.bootstrapToken);
    if (tokenGate !== null) {
      await recordAudit(tx, {
        actorId: SYSTEM_ACTOR_ID,
        requestId: ctx.requestId,
        operation: "users.create_first_owner",
        input,
        succeeded: false,
        resultSummary: tokenGate.summary,
      });
      return err({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: tokenGate.message,
      });
    }

    // From here on the token is redeemed: any failure must THROW (roll the
    // redemption back), never return an err that would commit it.
    const passwordHash = await hashPassword(input.password);
    const actorRows = (await tx.execute(sql`
      INSERT INTO actors (kind, display_name)
      VALUES ('human', ${input.displayName})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const actorId = actorRows[0]?.id;
    if (!actorId) {
      throw new OperationAbortError({
        kind: "HandlerError",
        operation: "users.create_first_owner",
        message: "actor insert returned no row",
        internal: true,
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
    if (input.bootstrapToken !== undefined) {
      await tx.execute(sql`
        UPDATE owner_bootstrap_tokens SET used_by = ${actorId}::uuid
        WHERE token = ${input.bootstrapToken}
      `);
    }

    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "users.create_first_owner",
      input,
      succeeded: true,
      entityId: actorId,
      resultSummary: `email=${input.email}`,
    });
    return ok({ userId: actorId });
  },
});

/**
 * The /setup token gate, run inside `users.create_first_owner`'s tx after
 * every other check. Returns null when the caller may proceed (no token was
 * ever issued — a raw `bun run dev` checkout — or `token` was valid and is
 * now marked used), otherwise the refusal to audit + return.
 */
async function redeemBootstrapToken(
  tx: TransactionRunner,
  token: string | undefined,
): Promise<{ summary: string; message: string } | null> {
  const issued = (await tx.execute(
    sql`SELECT EXISTS(SELECT 1 FROM owner_bootstrap_tokens) AS any_issued`,
  )) as unknown as { any_issued: boolean }[];
  if (issued[0]?.any_issued !== true) return null;
  if (token === undefined) {
    return {
      summary: "bootstrap-token-missing",
      message: "Bootstrap token required. Open the /setup?token=<…> link from the install output.",
    };
  }
  const redeemed = (await tx.execute(sql`
    UPDATE owner_bootstrap_tokens
    SET used_at = now()
    WHERE token = ${token} AND used_at IS NULL AND expires_at > now()
    RETURNING token
  `)) as unknown as { token: string }[];
  if (redeemed.length === 0) {
    return {
      summary: "bootstrap-token-rejected",
      message:
        "Bootstrap token invalid, expired, or already used. Open the latest /setup?token=<…> link from the install output; a token works once and expires 24 hours after it was issued.",
    };
  }
  return null;
}

export const isSetupCompleteOp = defineOperation({
  name: "users.is_setup_complete",
  // Why human-only (+system): auth-page read (see below); the agent has no use for it.
  // human + system: the /login and /setup loads run this with the
  // REQUEST's ctx, which is a human actor whenever a session cookie
  // is present. System-only scoping made every logged-in visit to
  // those pages fail the check and (via a since-removed silent
  // fallback) dumped signed-in users onto the setup form (live-hit
  // 2026-07-12). Harmless read — it leaks only "an owner exists".
  // RLS note: users is self-or-system, so a human actor sees exactly
  // their own row — which is all EXISTS needs, and session cookies
  // can only produce existing actors.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ complete: z.boolean() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT EXISTS(SELECT 1 FROM users WHERE deleted_at IS NULL) AS complete`,
    )) as unknown as { complete: boolean }[];
    return ok({ complete: rows[0]?.complete ?? false });
  },
});

export const listUsersOp = defineOperation({
  name: "users.list",
  // CLAUDE.md §11: read surface open to AI. Lets the AI answer
  // "which users have access?" without a human round-trip. Writes
  // (create, set_roles, delete) stay human-only — security domain.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }),
  output: z.object({
    users: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        displayName: z.string(),
        isFirstOwner: z.boolean(),
        createdAt: z.string(),
        deletedAt: z.string().nullable(),
        roles: z.array(z.string()),
      }),
    ),
  }),
  handler: async (ctx, input, tx) => {
    // users RLS is self-or-system; without this the list held only the
    // caller's own row (nothing at all for the AI), so list_users could
    // never name the user a propose_set_user_roles / propose_delete_user
    // targets. See withSystemRls.
    const rows = (await withSystemRls(tx, ctx, () =>
      tx.execute(
        input.includeDeleted
          ? sql`
            SELECT u.id::text AS id, u.email AS email, a.display_name AS "displayName",
                   u.is_first_owner AS "isFirstOwner", u.created_at AS "createdAt",
                   u.deleted_at AS "deletedAt"
            FROM users u JOIN actors a ON a.id = u.id
            ORDER BY u.created_at ASC
          `
          : sql`
            SELECT u.id::text AS id, u.email AS email, a.display_name AS "displayName",
                   u.is_first_owner AS "isFirstOwner", u.created_at AS "createdAt",
                   u.deleted_at AS "deletedAt"
            FROM users u JOIN actors a ON a.id = u.id
            WHERE u.deleted_at IS NULL
            ORDER BY u.created_at ASC
          `,
      ),
    )) as unknown as {
      id: string;
      email: string;
      displayName: string;
      isFirstOwner: boolean;
      createdAt: string | Date;
      deletedAt: string | Date | null;
    }[];

    const roleRows = (await tx.execute(sql`
      SELECT ur.user_id::text AS user_id, r.name AS role
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    `)) as unknown as { user_id: string; role: string }[];
    const roles = new Map<string, string[]>();
    for (const r of roleRows) {
      const arr = roles.get(r.user_id) ?? [];
      arr.push(r.role);
      roles.set(r.user_id, arr);
    }

    return ok({
      users: rows.map((u) => ({
        ...u,
        createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt),
        deletedAt:
          u.deletedAt === null
            ? null
            : u.deletedAt instanceof Date
              ? u.deletedAt.toISOString()
              : String(u.deletedAt),
        roles: roles.get(u.id) ?? [],
      })),
    });
  },
});

type OpTx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/**
 * #914 — why `email` could never get past the install's identity gate
 * (security/identity-gate.ts), as an AI- and operator-actionable message;
 * null when it can. Reads whether the Google sign-in client is set up in the
 * caller's transaction, so a proposal approved after the client was
 * removed is refused at apply time too.
 */
export async function identityGateRefusal(tx: OpTx, email: string): Promise<string | null> {
  const gate = currentIdentityGate();
  if (gate.kind === "none") return null;
  const rows = (await tx.execute(
    sql`SELECT 1 AS configured FROM operator_oauth_client LIMIT 1`,
  )) as unknown as { configured: number }[];
  const verdict = gate.check(email, { signInClientConfigured: rows.length > 0 });
  return verdict.ok ? null : identityGateMessage(verdict);
}

export const createUserOp = defineOperation({
  name: "users.create",
  // Why human-only: Owner-only — security domain.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(256),
    displayName: z.string().min(1).max(128),
    roleNames: z.array(z.string()).default([]),
  }),
  output: z.object({ userId: z.string() }),
  handler: async (ctx, input, tx) => {
    const dup = (await tx.execute(
      sql`SELECT 1 AS exists FROM users WHERE email = ${input.email} AND deleted_at IS NULL LIMIT 1`,
    )) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "users.create",
        input,
        succeeded: false,
        resultSummary: "email-already-exists",
      });
      return err({
        kind: "HandlerError",
        operation: "users.create",
        message: "email already exists",
      });
    }

    // #914 — never create a user the identity gate in front of the admin
    // will refuse (CLAUDE.md §2: fail loudly with the next step).
    const refusal = await identityGateRefusal(tx, input.email);
    if (refusal) {
      return err({ kind: "HandlerError", operation: "users.create", message: refusal });
    }

    const strength = validatePasswordStrength(input.password, {
      email: input.email,
      displayName: input.displayName,
    });
    if (!strength.ok) {
      return err({ kind: "HandlerError", operation: "users.create", message: strength.reason });
    }

    const passwordHash = await hashPassword(input.password);
    const actorRows = (await tx.execute(sql`
      INSERT INTO actors (kind, display_name)
      VALUES ('human', ${input.displayName})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const userId = actorRows[0]?.id;
    if (!userId) {
      return err({
        kind: "HandlerError",
        operation: "users.create",
        message: "no id returned",
        internal: true,
      });
    }
    await tx.execute(sql`
      INSERT INTO users (id, email, password_hash, is_first_owner)
      VALUES (${userId}::uuid, ${input.email}, ${passwordHash}, false)
    `);
    for (const roleName of input.roleNames) {
      await tx.execute(sql`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${userId}::uuid, r.id FROM roles r WHERE r.name = ${roleName}
        ON CONFLICT DO NOTHING
      `);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.create",
      input,
      succeeded: true,
      entityId: userId,
      resultSummary: `roles=${input.roleNames.join(",") || "(none)"}`,
    });
    return ok({ userId });
  },
});

/**
 * Refusal for a role change that would take `owner` from the first Owner —
 * the account that can always recover the install (PR #863, M-10). Shared
 * with `users.propose_set_roles` so the AI reads one actionable message.
 */
export const FIRST_OWNER_KEEPS_OWNER_ROLE =
  'cannot remove the owner role from the first Owner — keep "owner" in roleNames (other roles can be added next to it). To hand the site over, give another user the owner role instead.';

export const setUserRolesOp = defineOperation({
  name: "users.set_roles",
  // Why human-only: Owner-only — security domain.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    userId: z.string(),
    roleNames: z.array(z.string()),
  }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const targetRows = (await withSystemRls(tx, ctx, () =>
      tx.execute(sql`
        SELECT is_first_owner FROM users WHERE id = ${input.userId}::uuid LIMIT 1
      `),
    )) as unknown as { is_first_owner: boolean }[];
    if (targetRows[0]?.is_first_owner && !input.roleNames.includes("owner")) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "users.set_roles",
        input,
        succeeded: false,
        entityId: input.userId,
        resultSummary: "first-owner-protected",
      });
      return err({
        kind: "HandlerError",
        operation: "users.set_roles",
        message: FIRST_OWNER_KEEPS_OWNER_ROLE,
      });
    }
    await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${input.userId}::uuid`);
    for (const roleName of input.roleNames) {
      await tx.execute(sql`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${input.userId}::uuid, r.id FROM roles r WHERE r.name = ${roleName}
        ON CONFLICT DO NOTHING
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.set_roles",
      input,
      succeeded: true,
      entityId: input.userId,
      resultSummary: `roles=${input.roleNames.join(",") || "(none)"}`,
    });
    return ok({});
  },
});

/**
 * #970 — change a user's email: the fix for a user whose address has no
 * Google account (Google refuses to let it through IAP), offered next to
 * them on /settings/users. Same guards as creation: unique among active
 * users, and the identity gate must admit the new address. The next IAP
 * sync grants the new address and drops the old one.
 */
export const setUserEmailOp = defineOperation({
  name: "users.set_email",
  // Why human-only: Owner-only — security domain, like users.create. The
  // email is the user's sign-in identity and their IAP principal. The AI
  // changes users only through the approval-gated propose tools: for a
  // wrong address it proposes the user again with the right one and
  // proposes deleting the old one.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ userId: z.string().uuid(), email: z.string().trim().email().max(254) }),
  output: z.object({ previousEmail: z.string() }),
  handler: async (ctx, input, tx) => {
    const fail = async (message: string, summary: string) => {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "users.set_email",
        input,
        succeeded: false,
        entityId: input.userId,
        resultSummary: summary,
      });
      return err({ kind: "HandlerError" as const, operation: "users.set_email", message });
    };
    const rows = (await withSystemRls(tx, ctx, () =>
      tx.execute(sql`
        SELECT email FROM users WHERE id = ${input.userId}::uuid AND deleted_at IS NULL LIMIT 1
      `),
    )) as unknown as { email: string }[];
    const current = rows[0];
    if (!current) return fail("user not found (or deleted)", "not-found");
    if (current.email.toLowerCase() === input.email.toLowerCase()) {
      return fail(`the user already has the email ${input.email}`, "unchanged");
    }
    const dup = (await withSystemRls(tx, ctx, () =>
      tx.execute(sql`
        SELECT 1 AS exists FROM users
        WHERE lower(email) = lower(${input.email}) AND deleted_at IS NULL LIMIT 1
      `),
    )) as unknown as { exists: number }[];
    if (dup.length > 0) {
      return fail(`another user already has the email ${input.email}`, "email-already-exists");
    }
    const refusal = await identityGateRefusal(tx, input.email);
    if (refusal) return fail(refusal, "identity-gate");
    await withSystemRls(tx, ctx, () =>
      tx.execute(sql`UPDATE users SET email = ${input.email} WHERE id = ${input.userId}::uuid`),
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.set_email",
      input,
      succeeded: true,
      entityId: input.userId,
      resultSummary: `email changed from ${current.email}`,
    });
    return ok({ previousEmail: current.email });
  },
});

/**
 * Soft-delete: sets `deleted_at = now()`. Audit history stays linked because
 * the actor row + audit_events rows are untouched. A future `users.restore`
 * op can revive a soft-deleted account by clearing the flag.
 */
export const deleteUserOp = defineOperation({
  name: "users.delete",
  // Why human-only: Owner-only — security domain.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ userId: z.string() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT is_first_owner, deleted_at FROM users WHERE id = ${input.userId}::uuid
    `)) as unknown as { is_first_owner: boolean; deleted_at: Date | null }[];
    const target = rows[0];
    if (!target) {
      return err({ kind: "HandlerError", operation: "users.delete", message: "user not found" });
    }
    if (target.is_first_owner) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "users.delete",
        input,
        succeeded: false,
        entityId: input.userId,
        resultSummary: "first-owner-protected",
      });
      return err({
        kind: "HandlerError",
        operation: "users.delete",
        message: "cannot delete the first owner",
      });
    }
    if (target.deleted_at !== null) {
      // Already soft-deleted; idempotent — succeed without touching the row.
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "users.delete",
        input,
        succeeded: true,
        entityId: input.userId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    await tx.execute(sql`UPDATE users SET deleted_at = now() WHERE id = ${input.userId}::uuid`);
    // Revoke active sessions AND MCP bearer tokens so a soft-deleted user is
    // signed out everywhere at once — a token outlived its user before
    // (PR #863, M-09). resolveMcpToken also refuses a deleted user's token.
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${input.userId}::uuid`);
    const revoked = (await tx.execute(sql`
      UPDATE mcp_tokens SET revoked_at = now()
      WHERE actor_id = ${input.userId}::uuid AND revoked_at IS NULL
      RETURNING id
    `)) as unknown as { id: string }[];
    await tx.execute(sql`
      UPDATE mcp_remote_connections SET revoked_at = now()
      WHERE actor_id = ${input.userId}::uuid AND revoked_at IS NULL
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.delete",
      input,
      succeeded: true,
      entityId: input.userId,
      resultSummary: `soft-deleted; mcp-tokens-revoked=${revoked.length}`,
    });
    return ok({});
  },
});

/**
 * Self-service password change: the signed-in actor updates their OWN password.
 * Runs as the human actor — `users`/`sessions` are self-or-system under RLS, so
 * an actor mutating its own row needs no elevation. Verifies the current
 * password, enforces the strength policy on the new one, and (given the current
 * session token) revokes the actor's OTHER sessions so the change logs out
 * other devices while keeping this one alive.
 */
export const changePasswordOp = defineOperation({
  name: "users.change_password",
  // Why human-only: an actor changes their OWN credential; AI/system never do.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(1).max(256),
    /**
     * The caller's current session token — kept alive while every OTHER
     * session for this user is revoked. Omit to leave sessions untouched.
     */
    keepSessionToken: z.string().optional(),
  }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT u.email AS email, u.password_hash AS password_hash, a.display_name AS display_name
      FROM users u JOIN actors a ON a.id = u.id
      WHERE u.id = ${ctx.actorId}::uuid AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { email: string; password_hash: string; display_name: string }[];
    const user = rows[0];
    if (!user) {
      return err({
        kind: "HandlerError",
        operation: "users.change_password",
        message: "user not found",
      });
    }

    const currentOk = await verifyPassword(input.currentPassword, user.password_hash);
    if (!currentOk) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "users.change_password",
        input,
        succeeded: false,
        entityId: ctx.actorId,
        resultSummary: "wrong-current-password",
      });
      return err({
        kind: "HandlerError",
        operation: "users.change_password",
        message: "Current password is incorrect.",
      });
    }

    const strength = validatePasswordStrength(input.newPassword, {
      email: user.email,
      displayName: user.display_name,
    });
    if (!strength.ok) {
      return err({
        kind: "HandlerError",
        operation: "users.change_password",
        message: strength.reason,
      });
    }

    const newHash = await hashPassword(input.newPassword);
    await tx.execute(
      sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${ctx.actorId}::uuid`,
    );
    if (input.keepSessionToken) {
      await tx.execute(
        sql`DELETE FROM sessions WHERE user_id = ${ctx.actorId}::uuid AND token != ${input.keepSessionToken}`,
      );
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.change_password",
      input,
      succeeded: true,
      entityId: ctx.actorId,
      resultSummary: "password-changed",
    });
    return ok({});
  },
});

/**
 * Owner-initiated reset of ANOTHER user's password — the recovery path that
 * needs no email (a teammate locked out on an install with no mail transport).
 * Gated at the route by `users.manage` and executed in an ELEVATED context
 * (system kind, owner id preserved for the audit trail): `users`/`sessions` are
 * self-or-system under RLS, so a bare human owner cannot mutate a different
 * user's rows — the elevation is what clears RLS, exactly as
 * `create_first_owner` runs as system.
 */
export const adminSetPasswordOp = defineOperation({
  name: "users.admin_set_password",
  // Why human-only: sets another user's password — credentials never pass through the AI.
  // The route elevates to a system kind after a `users.manage` permission
  // check, so the cross-user write clears RLS. A bare human actor is blocked.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    userId: z.string().uuid(),
    newPassword: z.string().min(1).max(256),
  }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT u.email AS email, a.display_name AS display_name
      FROM users u JOIN actors a ON a.id = u.id
      WHERE u.id = ${input.userId}::uuid AND u.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { email: string; display_name: string }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "users.admin_set_password",
        message: "user not found",
      });
    }

    const strength = validatePasswordStrength(input.newPassword, {
      email: target.email,
      displayName: target.display_name,
    });
    if (!strength.ok) {
      return err({
        kind: "HandlerError",
        operation: "users.admin_set_password",
        message: strength.reason,
      });
    }

    const newHash = await hashPassword(input.newPassword);
    await tx.execute(
      sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${input.userId}::uuid`,
    );
    // Force the target to re-authenticate with the new password everywhere,
    // including active MCP bearer tokens and remote connections.
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${input.userId}::uuid`);
    await tx.execute(sql`
      UPDATE mcp_tokens SET revoked_at = now()
      WHERE actor_id = ${input.userId}::uuid AND revoked_at IS NULL
    `);
    await tx.execute(sql`
      UPDATE mcp_remote_connections SET revoked_at = now()
      WHERE actor_id = ${input.userId}::uuid AND revoked_at IS NULL
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.admin_set_password",
      input,
      succeeded: true,
      entityId: input.userId,
      resultSummary: "admin-reset",
    });
    return ok({});
  },
});

// v0.11.4 (issue #76 follow-up) — `users.complete_onboarding` removed
// along with the /onboarding tour. Caelo is chat-first per CLAUDE.md
// §1A: the operator opens /edit and describes outcomes; there is no
// forms-based onboarding step to "complete." The `users.onboarded_at`
// column stays for back-compat (avoiding a destructive migration on
// dogfood installs) but is no longer gate-checked or written.
