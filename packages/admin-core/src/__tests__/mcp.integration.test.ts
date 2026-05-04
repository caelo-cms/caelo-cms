// SPDX-License-Identifier: MPL-2.0

/**
 * P17 PR4 — MCP token lifecycle + auth resolution.
 *
 * The chat-runner-driven `mcp.send_chat` path is exercised end-to-end
 * by the dogfood loop in commit 3 (would require a real AIProvider
 * here, which the test suite doesn't pin to). This file proves the
 * non-AI half: token mint → list → revoke + auth-error shapes when
 * the bridge is invoked with revoked / expired / unknown tokens.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-test",
};
const ownerCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000001",
  actorKind: "human",
  requestId: "mcp-test-owner",
};

async function ensureOwnerActor(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${ownerCtx.actorId}::uuid, 'human', 'mcp-test owner')
               ON CONFLICT (id) DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
}

async function wipeOurRows(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM mcp_tokens WHERE actor_id = ${ownerCtx.actorId}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL!,
    publicDatabaseUrl: PUBLIC_URL!,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureOwnerActor();
  await wipeOurRows();
  // Bridge is configured with a stub AIProvider — we never invoke
  // mcp.send_chat with a valid token here (that's the dogfood loop's
  // job). The configure call exists so the not_found / revoked /
  // expired error paths return their auth-error shape instead of the
  // bridge-not-configured error.
  configureMcpBridge({
    adapter,
    registry,
    provider: {
      name: "stub",
      generate: async function* () {
        yield { kind: "done", stopReason: "end_turn" } as never;
      },
    } as never,
  });
});

afterAll(async () => {
  await wipeOurRows();
});

describe("mcp_tokens lifecycle", () => {
  let createdId: string;
  let plaintextToken: string;

  it("creates a token + returns the plaintext bearer ONCE", async () => {
    const r = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
      displayName: "test-laptop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { id: string; plaintextToken: string };
    expect(v.plaintextToken).toMatch(/^mcp_[0-9a-f]{64}$/);
    createdId = v.id;
    plaintextToken = v.plaintextToken;
  });

  it("lists the new token without leaking the plaintext", async () => {
    const r = await execute(registry, adapter, ownerCtx, "mcp_tokens.list", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      tokens: Array<{ id: string; displayName: string; revokedAt: string | null }>;
    };
    const row = v.tokens.find((t) => t.id === createdId);
    expect(row).toBeDefined();
    expect(row?.displayName).toBe("test-laptop");
    expect(row?.revokedAt).toBeNull();
    // The list MUST NOT include the plaintext anywhere — only the hash.
    expect(JSON.stringify(v)).not.toContain(plaintextToken);
  });

  it("rejects mcp.send_chat with an unknown token (auth_error: token not_found)", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.send_chat", {
      plaintextToken: "mcp_doesnotexist0000000000000000000000000000000000000000000000000000",
      message: "hello",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("message" in r.error && r.error.message).toMatch(/auth_error: token not_found/);
  });

  it("revokes the token + subsequent send_chat fails with auth_error: token revoked", async () => {
    const revoke = await execute(registry, adapter, ownerCtx, "mcp_tokens.revoke", {
      id: createdId,
    });
    expect(revoke.ok).toBe(true);
    const r = await execute(registry, adapter, systemCtx, "mcp.send_chat", {
      plaintextToken,
      message: "hello",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("message" in r.error && r.error.message).toMatch(/auth_error: token revoked/);
  });

  it("rejects send_chat for an expired token (auth_error: token expired)", async () => {
    const sql = new SQL(ADMIN_URL!);
    let expiredPlain: string;
    try {
      const r = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
        displayName: "test-expired",
      });
      if (!r.ok) throw new Error("create failed");
      expiredPlain = (r.value as { plaintextToken: string }).plaintextToken;
      const id = (r.value as { id: string }).id;
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE mcp_tokens SET expires_at = now() - interval '1 day' WHERE id = ${id}::uuid`;
      });
    } finally {
      await sql.end();
    }
    const r = await execute(registry, adapter, systemCtx, "mcp.send_chat", {
      plaintextToken: expiredPlain,
      message: "hello",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("message" in r.error && r.error.message).toMatch(/auth_error: token expired/);
  });

  it("auth scope rejects AI-actor token mint", async () => {
    const aiCtx: ExecutionContext = {
      actorId: ownerCtx.actorId,
      actorKind: "ai",
      requestId: "mcp-test-ai",
    };
    const r = await execute(registry, adapter, aiCtx, "mcp_tokens.create", {
      displayName: "ai-attempt",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ActorScopeRejected");
  });
});
