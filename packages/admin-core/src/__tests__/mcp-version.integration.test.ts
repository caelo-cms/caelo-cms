// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, expect, test } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { SQL } from "bun";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

/**
 * Issue #764 — mcp.get_version tells the shim which release to re-exec
 * as. Any live token may ask; dead tokens learn nothing.
 */

const adminUrl = process.env.ADMIN_DATABASE_URL!;
const adapter = new DatabaseAdapter({
  adminDatabaseUrl: adminUrl,
  publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL!,
});
const registry = new OperationRegistry();
registerAdminOps(registry);
const db = new SQL(adminUrl);
const actorId = crypto.randomUUID();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "mcp-version-test",
};
const human = { ...system, actorId, actorKind: "human" as const };

beforeAll(async () => {
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${actorId}::uuid, 'human', 'Version test')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${actorId}::uuid, ${`${actorId}@example.test`}, 'unused')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${actorId}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  configureMcpBridge({ adapter, registry, resolveProvider: async () => new FixtureProvider([]) });
});
afterAll(async () => {
  await adapter.close();
  await db.end();
});

async function mint(scope: "chat" | "admin") {
  const r = await execute(registry, adapter, human, "mcp_tokens.create", {
    displayName: "version-test",
    scope,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as { id: string; plaintextToken: string };
}
const getVersion = (plaintextToken: string) =>
  execute(registry, adapter, system, "mcp.get_version", { plaintextToken });

test("chat and admin tokens get the admin's release; unknown, revoked and expired tokens do not", async () => {
  for (const scope of ["chat", "admin"] as const) {
    const token = await mint(scope);
    const r = await getVersion(token.plaintextToken);
    expect(r.ok && r.value).toEqual({ version: CAELO_VERSION });
    await execute(registry, adapter, human, "mcp_tokens.revoke", { id: token.id });
    const revoked = await getVersion(token.plaintextToken);
    expect(!revoked.ok && "message" in revoked.error && revoked.error.message).toBe(
      "auth_error: token revoked",
    );
  }
  expect((await getVersion("mcp_unknown_token")).ok).toBe(false);
  const expired = await mint("chat");
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`UPDATE mcp_tokens SET expires_at = now() - interval '1 day' WHERE id = ${expired.id}::uuid`;
  });
  expect((await getVersion(expired.plaintextToken)).ok).toBe(false);
});

test("the op is system-only — an AI actor cannot call it", async () => {
  const token = await mint("admin");
  const r = await execute(registry, adapter, { ...system, actorKind: "ai" }, "mcp.get_version", {
    plaintextToken: token.plaintextToken,
  });
  expect(r.ok).toBe(false);
});
