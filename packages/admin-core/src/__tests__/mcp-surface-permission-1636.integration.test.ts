// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1636 — the Power-MCP surface follows the chat's permission and is
 * no longer called "admin", against a real Postgres:
 *
 *   - whoever may work through an AI mints a token for themselves; "may use
 *     Caelo's AI" stays with the Owner; a read-only role mints nothing;
 *   - a token or a connection stored before the rename (`admin`) keeps
 *     working and reads as `power`, and nothing new is stored under the old
 *     spelling;
 *   - an approval card queued before the rename still applies.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { McpRemoteCredential } from "../ops/security/mcp_credential.js";
import { resolveRemoteMcpPrincipal } from "../ops/security/mcp_principal.js";
import {
  configureMcpBridge,
  createMcpTokenOp,
  resolveMcpPrincipal,
} from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";
import { createIapVerifier, setIapVerifierForTests } from "../security/iap-assertion.js";
import { iapTestKeyPair, signIapTestAssertion } from "../security/iap-assertion.test-helpers.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const AUDIENCE = "/projects/42/locations/europe-west1/services/caelo-admin-1636";
const KEY = iapTestKeyPair("t1636-kid");
const APP = "dcr:t1636 app";

const USERS = {
  owner: { id: "00000000-0000-4000-9636-000000000001", email: "owner@t1636.test", role: "owner" },
  editor: {
    id: "00000000-0000-4000-9636-000000000002",
    email: "editor@t1636.test",
    role: "editor",
  },
  reviewer: {
    id: "00000000-0000-4000-9636-000000000003",
    email: "reviewer@t1636.test",
    role: "reviewer",
  },
} as const;

const human = (who: keyof typeof USERS): ExecutionContext => ({
  actorId: USERS[who].id,
  actorKind: "human",
  requestId: `t1636-${who}`,
});

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    for (const u of Object.values(USERS)) {
      await tx`DELETE FROM mcp_remote_connections WHERE actor_id = ${u.id}::uuid`;
      await tx`DELETE FROM mcp_token_pending_actions WHERE proposed_by = ${u.id}::uuid`;
      await tx`DELETE FROM mcp_tokens WHERE actor_id = ${u.id}::uuid`;
    }
  });
}

const message = (r: { ok: boolean; error?: unknown }): string =>
  !r.ok && typeof r.error === "object" && r.error !== null && "message" in r.error
    ? String((r.error as { message: unknown }).message)
    : "";

function remote(email: string): McpRemoteCredential {
  return {
    iapCredential: signIapTestAssertion(KEY, { aud: AUDIENCE, email }),
    surface: "power",
    client: APP,
  };
}

/** What a table really holds, in the stored spelling. */
async function stored(table: "mcp_tokens" | "mcp_remote_connections", actorId: string) {
  return withSql(async (tx) =>
    table === "mcp_tokens"
      ? ((await tx`SELECT id::text AS id, scope AS value, allow_caelo_ai
                   FROM mcp_tokens WHERE actor_id = ${actorId}::uuid ORDER BY created_at`) as {
          id: string;
          value: string;
          allow_caelo_ai: boolean;
        }[])
      : ((await tx`SELECT id::text AS id, surface AS value, allow_caelo_ai
                   FROM mcp_remote_connections WHERE actor_id = ${actorId}::uuid
                   ORDER BY created_at`) as {
          id: string;
          value: string;
          allow_caelo_ai: boolean;
        }[]),
  );
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await withSql(async (tx) => {
    for (const u of Object.values(USERS)) {
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${u.id}::uuid, 'human', ${u.email}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${u.id}::uuid, ${u.email}, 'test-only') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${u.id}::uuid, id FROM roles WHERE name = ${u.role}
               ON CONFLICT DO NOTHING`;
    }
  });
  await wipe();
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => AUDIENCE,
      keys: async () => ({ [KEY.kid]: KEY.publicPem }),
    }),
  );
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
});

afterAll(async () => {
  setIapVerifierForTests(null);
  await wipe();
  await adapter.close();
});

describe("who may mint an MCP token (#1636)", () => {
  it("an editor mints a Power token for themselves, and it acts as the editor", async () => {
    const minted = await execute(registry, adapter, human("editor"), "mcp_tokens.create", {
      displayName: "editor's own agent",
      scope: "power",
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const { plaintextToken } = minted.value as { plaintextToken: string };
    const principal = await resolveMcpPrincipal(
      adapter,
      { plaintextToken },
      { surface: "power", operation: "mcp.list_tools" },
    );
    expect(principal.ok && [principal.principal.actorId, principal.principal.scope]).toEqual([
      USERS.editor.id,
      "power",
    ]);
    // Without the Owner's opt-in the agent's AI work stays on its own subscription.
    expect(principal.ok && principal.principal.allowCaeloAi).toBe(false);
    expect((await stored("mcp_tokens", USERS.editor.id)).map((t) => t.value)).toEqual(["power"]);
  });

  it("keeps 'may use Caelo's AI' with the Owner", async () => {
    const editor = await execute(registry, adapter, human("editor"), "mcp_tokens.create", {
      displayName: "editor wants the install's AI",
      scope: "power",
      allowCaeloAi: true,
    });
    expect(message(editor)).toContain("permission_denied");
    expect(message(editor)).toContain("settings.write");
    // Nothing was minted by the refused call.
    expect(await stored("mcp_tokens", USERS.editor.id)).toHaveLength(1);

    const owner = await execute(registry, adapter, human("owner"), "mcp_tokens.create", {
      displayName: "owner's agent with the install's AI",
      scope: "power",
      allowCaeloAi: true,
    });
    expect(owner.ok).toBe(true);
    expect((await stored("mcp_tokens", USERS.owner.id)).map((t) => t.allow_caelo_ai)).toEqual([
      true,
    ]);
  });

  it("an approval card with 'may use Caelo's AI' stays pending until an Owner approves it", async () => {
    const proposed = await execute(
      registry,
      adapter,
      human("editor"),
      "mcp_tokens.propose_create",
      { displayName: "proposed with the install's AI", scope: "power", allowCaeloAi: true },
    );
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId } = proposed.value as { proposalId: string };
    const status = async () =>
      withSql(
        async (tx) =>
          (
            (await tx`SELECT status FROM mcp_token_pending_actions
                      WHERE id = ${proposalId}::uuid`) as { status: string }[]
          )[0]?.status,
      );

    const byEditor = await execute(
      registry,
      adapter,
      human("editor"),
      "mcp_tokens.execute_proposal",
      { proposalId },
    );
    // The shape of a missing approver permission: nothing applied, still pending.
    expect(message(byEditor)).toMatch(/^permission_denied: /);
    expect(message(byEditor)).toContain("settings.write");
    expect(await status()).toBe("pending");

    const byOwner = await execute(
      registry,
      adapter,
      human("owner"),
      "mcp_tokens.execute_proposal",
      { proposalId },
    );
    expect(byOwner.ok).toBe(true);
    expect(await status()).toBe("applied");
    // It acts as the Owner who approved it, not as the editor who asked.
    const minted = (await stored("mcp_tokens", USERS.owner.id)).filter((t) => t.allow_caelo_ai);
    expect(minted).toHaveLength(2);
  });

  it("refuses a role that may not edit content, on either scope", async () => {
    for (const scope of ["chat", "power"] as const) {
      const r = await execute(registry, adapter, human("reviewer"), "mcp_tokens.create", {
        displayName: `reviewer ${scope}`,
        scope,
      });
      expect(message(r)).toContain("permission_denied");
      expect(message(r)).toContain("content.write");
    }
    expect(await stored("mcp_tokens", USERS.reviewer.id)).toHaveLength(0);
  });

  it("shows an editor only their own tokens, an Owner everyone's (0315)", async () => {
    const list = async (who: "owner" | "editor") => {
      const r = await execute(registry, adapter, human(who), "mcp_tokens.list", {});
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value as { visibility: string; tokens: { actorId: string; scope: string }[] };
    };
    const editor = await list("editor");
    expect(editor.visibility).toBe("own");
    expect(editor.tokens.map((t) => t.actorId)).toEqual([USERS.editor.id]);
    const owner = await list("owner");
    expect(owner.visibility).toBe("all");
    expect(new Set(owner.tokens.map((t) => t.actorId))).toEqual(
      new Set([USERS.editor.id, USERS.owner.id]),
    );
  });
});

describe("what was stored before the rename keeps working (#1636)", () => {
  it("a token stored as 'admin' opens the Power surface and reads as 'power'", async () => {
    const minted = await execute(registry, adapter, human("owner"), "mcp_tokens.create", {
      displayName: "from before the rename",
      scope: "power",
    });
    if (!minted.ok) throw new Error(JSON.stringify(minted.error));
    const { id, plaintextToken } = minted.value as { id: string; plaintextToken: string };
    await withSql((tx) => tx`UPDATE mcp_tokens SET scope = 'admin' WHERE id = ${id}::uuid`);

    const principal = await resolveMcpPrincipal(
      adapter,
      { plaintextToken },
      { surface: "power", operation: "mcp.list_tools" },
    );
    expect(principal.ok && principal.principal.scope).toBe("power");
    const listed = await execute(registry, adapter, human("owner"), "mcp_tokens.list", {});
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const tokens = (listed.value as { tokens: { id: string; scope: string }[] }).tokens;
      expect(tokens.find((t) => t.id === id)?.scope).toBe("power");
    }
  });

  it("a connection stored as 'admin' is the app's one Power connection: no second row, revocation kept", async () => {
    await withSql(
      (tx) => tx`
        INSERT INTO mcp_remote_connections (actor_id, surface, client_key, ai_cost_cap_microcents)
        VALUES (${USERS.owner.id}::uuid, 'admin', ${APP}, 1234)`,
    );
    const first = await resolveRemoteMcpPrincipal(adapter, remote(USERS.owner.email));
    expect(first.ok && [first.value.scope, first.value.aiCostCapMicrocents]).toEqual([
      "power",
      1234,
    ]);
    const rows = await stored("mcp_remote_connections", USERS.owner.id);
    // The old row serves the request; it is not rewritten under a running release.
    expect(rows.map((r) => r.value)).toEqual(["admin"]);
    expect(first.ok && first.value.via.kind === "remote" && first.value.via.connectionId).toBe(
      rows[0]?.id ?? "",
    );

    const listed = await execute(
      registry,
      adapter,
      human("owner"),
      "mcp_remote_connections.list",
      {},
    );
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const mine = (
      listed.value as { connections: { id: string; surface: string }[] }
    ).connections.filter((c) => c.id === rows[0]?.id);
    expect(mine.map((c) => c.surface)).toEqual(["power"]);

    const revoked = await execute(
      registry,
      adapter,
      human("owner"),
      "mcp_remote_connections.revoke",
      { id: rows[0]?.id ?? "" },
    );
    expect(revoked.ok).toBe(true);
    const after = await resolveRemoteMcpPrincipal(adapter, remote(USERS.owner.email));
    expect(!after.ok && after.error.code).toBe("remote_access_revoked");
    expect(await stored("mcp_remote_connections", USERS.owner.id)).toHaveLength(1);
  });

  it("a new connection is stored as 'power'", async () => {
    const r = await resolveRemoteMcpPrincipal(adapter, remote(USERS.editor.email));
    expect(r.ok).toBe(true);
    expect((await stored("mcp_remote_connections", USERS.editor.id)).map((c) => c.value)).toEqual([
      "power",
    ]);
  });

  it("an approval card queued before the rename mints a Power token", async () => {
    // The approval path hands the stored payload to the handler without a
    // Zod parse; before #1636 the AI's proposal said `scope: "admin"`.
    const legacyPayload = { displayName: "queued before the rename", scope: "admin" } as never;
    const r = await adapter.withAdminTransaction(human("owner"), (tx) =>
      createMcpTokenOp.handler(human("owner"), legacyPayload, tx),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = (r.value as { id: string }).id;
    const row = (await stored("mcp_tokens", USERS.owner.id)).find((t) => t.id === id);
    expect(row?.value).toBe("power");
  });
});
