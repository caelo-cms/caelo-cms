// SPDX-License-Identifier: MPL-2.0

/**
 * Password change + self-service reset + owner reset, against a real Postgres.
 *
 * Covers the security-critical invariants: strength enforcement at every
 * set-point, current-password verification, no account enumeration on request,
 * single-use + expiring reset tokens, and session revocation on reset / owner
 * reset. Emails are scoped to `pwreset-…@example.test` so the suite self-wipes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { hashResetToken } from "../tokens.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "pwreset-sys",
};

const EMAIL_PREFIX = "pwreset-";
const STRONG = "purple-hatstand-92";
const STRONG_2 = "green-lantern-tuesday-7";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
      await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
      await tx`DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
      await tx`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`;
      await tx`DELETE FROM actors WHERE display_name LIKE 'PWReset %'`;
    });
  } finally {
    await sql.end();
  }
}

/** Create an owner-less regular user via `users.create` (runs as system). */
async function makeUser(email: string): Promise<string> {
  const res = await execute(registry, adapter, systemCtx, "users.create", {
    email,
    password: STRONG,
    displayName: `PWReset ${email}`,
    roleNames: [],
  });
  if (!res.ok) throw new Error(`makeUser failed: ${JSON.stringify(res.error)}`);
  return (res.value as { userId: string }).userId;
}

async function sessionCount(userId: string): Promise<number> {
  const sql = new SQL(ADMIN_URL!);
  try {
    let n = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows =
        (await tx`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}::uuid`) as unknown as {
          n: number;
        }[];
      n = rows[0]?.n ?? 0;
    });
    return n;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("users.change_password", () => {
  it("changes the password after verifying the current one, and re-login reflects it", async () => {
    const email = `${EMAIL_PREFIX}change@example.test`;
    const userId = await makeUser(email);
    const humanCtx: ExecutionContext = { actorId: userId, actorKind: "human", requestId: "chg" };

    const changed = await execute(registry, adapter, humanCtx, "users.change_password", {
      currentPassword: STRONG,
      newPassword: STRONG_2,
    });
    expect(changed.ok).toBe(true);

    // Old password no longer works; the new one does.
    const oldLogin = await execute(registry, adapter, systemCtx, "auth.login", {
      email,
      password: STRONG,
    });
    expect(oldLogin.ok).toBe(false);
    const newLogin = await execute(registry, adapter, systemCtx, "auth.login", {
      email,
      password: STRONG_2,
    });
    expect(newLogin.ok).toBe(true);
  });

  it("rejects a wrong current password", async () => {
    const email = `${EMAIL_PREFIX}wrongcur@example.test`;
    const userId = await makeUser(email);
    const humanCtx: ExecutionContext = { actorId: userId, actorKind: "human", requestId: "chg2" };
    const res = await execute(registry, adapter, humanCtx, "users.change_password", {
      currentPassword: "not-the-password",
      newPassword: STRONG_2,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a weak new password", async () => {
    const email = `${EMAIL_PREFIX}weak@example.test`;
    const userId = await makeUser(email);
    const humanCtx: ExecutionContext = { actorId: userId, actorKind: "human", requestId: "chg3" };
    const res = await execute(registry, adapter, humanCtx, "users.change_password", {
      currentPassword: STRONG,
      newPassword: "password123",
    });
    expect(res.ok).toBe(false);
  });

  it("revokes OTHER sessions but keeps the current one", async () => {
    const email = `${EMAIL_PREFIX}sessions@example.test`;
    const userId = await makeUser(email);
    const humanCtx: ExecutionContext = { actorId: userId, actorKind: "human", requestId: "chg4" };
    // Two logins → two sessions.
    const a = await execute(registry, adapter, systemCtx, "auth.login", {
      email,
      password: STRONG,
    });
    const b = await execute(registry, adapter, systemCtx, "auth.login", {
      email,
      password: STRONG,
    });
    expect(a.ok && b.ok).toBe(true);
    expect(await sessionCount(userId)).toBe(2);
    const keep = (a as { value: { token: string } }).value.token;

    const changed = await execute(registry, adapter, humanCtx, "users.change_password", {
      currentPassword: STRONG,
      newPassword: STRONG_2,
      keepSessionToken: keep,
    });
    expect(changed.ok).toBe(true);
    // Only the kept session survives.
    expect(await sessionCount(userId)).toBe(1);
  });
});

describe("users.admin_set_password", () => {
  it("sets another user's password (elevated) and revokes their sessions", async () => {
    const email = `${EMAIL_PREFIX}target@example.test`;
    const userId = await makeUser(email);
    await execute(registry, adapter, systemCtx, "auth.login", { email, password: STRONG });
    expect(await sessionCount(userId)).toBe(1);

    // The route runs this in a system-kind context (owner id preserved for
    // audit); the op only needs the system elevation to clear RLS. Use the
    // seeded system actor here so the audit row's actor FK resolves.
    const res = await execute(registry, adapter, systemCtx, "users.admin_set_password", {
      userId,
      newPassword: STRONG_2,
    });
    expect(res.ok).toBe(true);
    expect(await sessionCount(userId)).toBe(0); // sessions killed

    const login = await execute(registry, adapter, systemCtx, "auth.login", {
      email,
      password: STRONG_2,
    });
    expect(login.ok).toBe(true);
  });

  it("rejects a weak password", async () => {
    const email = `${EMAIL_PREFIX}targetweak@example.test`;
    const userId = await makeUser(email);
    const res = await execute(registry, adapter, systemCtx, "users.admin_set_password", {
      userId,
      newPassword: "qwertyuiop",
    });
    expect(res.ok).toBe(false);
  });
});

describe("auth.request_password_reset", () => {
  it("issues a token for an existing account", async () => {
    const email = `${EMAIL_PREFIX}req@example.test`;
    const userId = await makeUser(email);
    const res = await execute(registry, adapter, systemCtx, "auth.request_password_reset", {
      email,
    });
    expect(res.ok).toBe(true);
    const delivery = (res as { value: { delivery: unknown } }).value.delivery;
    expect(delivery).not.toBeNull();

    const sql = new SQL(ADMIN_URL!);
    try {
      let n = 0;
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows =
          (await tx`SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = ${userId}::uuid`) as unknown as {
            n: number;
          }[];
        n = rows[0]?.n ?? 0;
      });
      expect(n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("does NOT enumerate — unknown email returns null delivery and issues no token", async () => {
    const res = await execute(registry, adapter, systemCtx, "auth.request_password_reset", {
      email: `${EMAIL_PREFIX}nobody@example.test`,
    });
    expect(res.ok).toBe(true);
    expect((res as { value: { delivery: unknown } }).value.delivery).toBeNull();
  });
});

describe("auth.reset_password", () => {
  async function issueToken(email: string): Promise<string> {
    const res = await execute(registry, adapter, systemCtx, "auth.request_password_reset", {
      email,
    });
    if (!res.ok) throw new Error("request failed");
    const d = (res.value as { delivery: { token: string } | null }).delivery;
    if (!d) throw new Error("no delivery");
    return d.token;
  }

  it("resets with a valid token, then that token can't be reused", async () => {
    const email = `${EMAIL_PREFIX}reset@example.test`;
    const userId = await makeUser(email);
    await execute(registry, adapter, systemCtx, "auth.login", { email, password: STRONG });
    const token = await issueToken(email);

    const first = await execute(registry, adapter, systemCtx, "auth.reset_password", {
      token,
      newPassword: STRONG_2,
    });
    expect(first.ok).toBe(true);
    expect(await sessionCount(userId)).toBe(0); // reset kills all sessions

    // New password works; old fails.
    expect(
      (await execute(registry, adapter, systemCtx, "auth.login", { email, password: STRONG_2 })).ok,
    ).toBe(true);

    // The token is single-use.
    const reuse = await execute(registry, adapter, systemCtx, "auth.reset_password", {
      token,
      newPassword: "another-good-one-8",
    });
    expect(reuse.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const email = `${EMAIL_PREFIX}expired@example.test`;
    const userId = await makeUser(email);
    const rawToken = "expired-raw-token-value-123456";
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
                 VALUES (${userId}::uuid, ${hashResetToken(rawToken)}, now() - interval '1 minute')`;
      });
    } finally {
      await sql.end();
    }
    const res = await execute(registry, adapter, systemCtx, "auth.reset_password", {
      token: rawToken,
      newPassword: STRONG_2,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects an unknown token", async () => {
    const res = await execute(registry, adapter, systemCtx, "auth.reset_password", {
      token: "this-token-was-never-issued",
      newPassword: STRONG_2,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a weak new password even with a valid token", async () => {
    const email = `${EMAIL_PREFIX}resetweak@example.test`;
    await makeUser(email);
    const token = await issueToken(email);
    const res = await execute(registry, adapter, systemCtx, "auth.reset_password", {
      token,
      newPassword: "letmein123",
    });
    expect(res.ok).toBe(false);
  });
});
