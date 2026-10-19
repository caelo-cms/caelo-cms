// SPDX-License-Identifier: MPL-2.0

/**
 * PR #863 (L-06) — `users.create_first_owner` redeems the single-use /setup
 * bootstrap token inside its own transaction, after every other check. A
 * rejected attempt (missing / wrong / expired token, weak password, bad
 * email) must leave the token usable; only a created Owner marks it used.
 * Pre-fix /setup consumed the token in a separate op first, so any later
 * failure burned it and stranded the install.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "first-owner-token-test",
};

const EMAIL = "first-owner-token@example.com";
const PASSWORD = "harbor-violet-lantern-58";
const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** Run raw SQL as the system actor (users + tokens are system-RLS). */
async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

/** A fresh install: no live user, no token ever issued. */
async function resetInstall(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM owner_bootstrap_tokens`;
    await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`;
    await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`;
    await tx`DELETE FROM users WHERE email = ${EMAIL}`;
    // Any other live user (another file's seed) would make setup "complete".
    await tx`UPDATE users SET deleted_at = now() WHERE deleted_at IS NULL`;
  });
}

async function issue(token: string, expiresAt: Date): Promise<void> {
  const r = await execute(registry, adapter, systemCtx, "owner_bootstrap_tokens.insert", {
    token,
    expiresAt: expiresAt.toISOString(),
  });
  expect(r.ok).toBe(true);
}

async function tokenRow(token: string): Promise<{ used_at: Date | null; used_by: string | null }> {
  const rows = (await asSystem(
    (tx) =>
      tx`SELECT used_at, used_by::text AS used_by FROM owner_bootstrap_tokens WHERE token = ${token}`,
  )) as { used_at: Date | null; used_by: string | null }[];
  const row = rows[0];
  if (!row) throw new Error(`token ${token.slice(0, 4)}… not found`);
  return row;
}

async function liveUserCount(): Promise<number> {
  const rows = (await asSystem(
    (tx) => tx`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`,
  )) as { n: number }[];
  return rows[0]?.n ?? -1;
}

function createFirstOwner(extra: Record<string, unknown> = {}) {
  return execute(registry, adapter, systemCtx, "users.create_first_owner", {
    email: EMAIL,
    password: PASSWORD,
    displayName: "First Owner",
    ...extra,
  });
}

function message(r: { ok: boolean; error?: unknown }): string {
  return String((r.error as { message?: string } | undefined)?.message ?? "");
}

const inADay = () => new Date(Date.now() + 24 * 3600 * 1000);

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(resetInstall);

afterAll(async () => {
  await resetInstall();
  await adapter.close();
});

describe("users.create_first_owner bootstrap-token gate", () => {
  it("needs no token on an install that never issued one (raw dev checkout)", async () => {
    const r = await createFirstOwner();
    expect(r.ok).toBe(true);
  });

  it("refuses without a token once one was issued, and keeps it usable", async () => {
    await issue(TOKEN, inADay());
    const r = await createFirstOwner();
    expect(r.ok).toBe(false);
    expect(message(r)).toContain("Bootstrap token required");
    expect((await tokenRow(TOKEN)).used_at).toBeNull();
    expect(await liveUserCount()).toBe(0);
  });

  it("a weak password does not burn the token", async () => {
    await issue(TOKEN, inADay());
    const r = await createFirstOwner({ password: "password12", bootstrapToken: TOKEN });
    expect(r.ok).toBe(false);
    expect((await tokenRow(TOKEN)).used_at).toBeNull();
    // ...so the corrected retry with the same token succeeds.
    expect((await createFirstOwner({ bootstrapToken: TOKEN })).ok).toBe(true);
  });

  it("an invalid email does not burn the token", async () => {
    await issue(TOKEN, inADay());
    const r = await createFirstOwner({ email: "not-an-email", bootstrapToken: TOKEN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ValidationFailed");
    expect((await tokenRow(TOKEN)).used_at).toBeNull();
  });

  it("rejects a wrong or expired token without touching the valid one", async () => {
    await issue(TOKEN, inADay());
    await issue(OTHER_TOKEN, new Date(Date.now() - 1000));
    for (const bootstrapToken of ["c".repeat(64), OTHER_TOKEN]) {
      const r = await createFirstOwner({ bootstrapToken });
      expect(r.ok).toBe(false);
      expect(message(r)).toContain("invalid, expired, or already used");
    }
    expect((await tokenRow(TOKEN)).used_at).toBeNull();
    expect(await liveUserCount()).toBe(0);
  });

  it("marks the token used by the new Owner on success, and never again", async () => {
    await issue(TOKEN, inADay());
    const r = await createFirstOwner({ bootstrapToken: TOKEN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await tokenRow(TOKEN);
    expect(row.used_at).not.toBeNull();
    expect(row.used_by).toBe((r.value as { userId: string }).userId);

    // Replaying the same token after the owner is gone is still refused.
    await asSystem((tx) => tx`UPDATE users SET deleted_at = now() WHERE email = ${EMAIL}`);
    const replay = await createFirstOwner({ email: "replay@example.com", bootstrapToken: TOKEN });
    expect(replay.ok).toBe(false);
    expect(message(replay)).toContain("already used");
  });
});
