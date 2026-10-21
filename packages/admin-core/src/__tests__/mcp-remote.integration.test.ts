// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — remote MCP connections against a real Postgres: IAP
 * identity → Caelo user → `mcp_remote_connections` row (auto-create,
 * permission gate, sticky revoke), the Owner's ops, and the `mcp.*` ops
 * running on a remote credential with the same behaviour and attribution a
 * token gets. The IAP assertion is signed with generated ES256 keys through
 * the verifier's key-provider seam.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { McpRemoteCredential } from "../ops/security/mcp_credential.js";
import { resolveRemoteMcpPrincipal } from "../ops/security/mcp_principal.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";
import { createIapVerifier, setIapVerifierForTests } from "../security/iap-assertion.js";
import { iapTestKeyPair, signIapTestAssertion } from "../security/iap-assertion.test-helpers.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const AUDIENCE = "/projects/42/locations/europe-west1/services/caelo-admin";
const KEY = iapTestKeyPair("t806-kid");
let audience: string | undefined = AUDIENCE;

const USERS = {
  owner: { id: "00000000-0000-4000-8806-000000000001", email: "Owner@T806.test", role: "owner" },
  editor: { id: "00000000-0000-4000-8806-000000000002", email: "editor@t806.test", role: "editor" },
  reviewer: {
    id: "00000000-0000-4000-8806-000000000003",
    email: "reviewer@t806.test",
    role: "reviewer",
  },
  roleless: { id: "00000000-0000-4000-8806-000000000004", email: "roleless@t806.test", role: null },
  deleted: {
    id: "00000000-0000-4000-8806-000000000005",
    email: "deleted@t806.test",
    role: "owner",
  },
} as const;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t806-system",
};
const ownerCtx: ExecutionContext = {
  actorId: USERS.owner.id,
  actorKind: "human",
  requestId: "t806-owner",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const CLAUDE_CODE = "dcr:Claude Code";
const CHATGPT = "https://chatgpt.com/oauth/client.json";

function cred(
  email: string,
  surface: "chat" | "admin",
  client: string = CLAUDE_CODE,
): McpRemoteCredential {
  return { iapCredential: signIapTestAssertion(KEY, { aud: AUDIENCE, email }), surface, client };
}

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
      await tx`DELETE FROM mcp_remote_access_blocks WHERE actor_id = ${u.id}::uuid`;
      await tx`DELETE FROM mcp_tokens WHERE actor_id = ${u.id}::uuid`;
    }
  });
}

async function connectionRow(actorId: string, surface: string, client: string = CLAUDE_CODE) {
  return withSql(
    async (tx) =>
      (
        (await tx`SELECT id::text AS id, revoked_at, current_chat_session_id::text AS current
                  FROM mcp_remote_connections
                  WHERE actor_id = ${actorId}::uuid AND surface = ${surface}
                    AND client_key = ${client}`) as {
          id: string;
          revoked_at: Date | null;
          current: string | null;
        }[]
      )[0],
  );
}

const message = (r: { ok: boolean; error?: unknown }): string =>
  !r.ok && typeof r.error === "object" && r.error !== null && "message" in r.error
    ? String((r.error as { message: unknown }).message)
    : "";

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
      if (u.role) {
        await tx`INSERT INTO user_roles (user_id, role_id)
                 SELECT ${u.id}::uuid, id FROM roles WHERE name = ${u.role}
                 ON CONFLICT DO NOTHING`;
      }
    }
    await tx`UPDATE users SET deleted_at = now() WHERE id = ${USERS.deleted.id}::uuid`;
  });
  await wipe();
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => audience,
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

describe("remote principal resolution", () => {
  it("auto-creates the Owner's admin connection once and maps the email case-insensitively", async () => {
    const first = await resolveRemoteMcpPrincipal(adapter, cred("owner@t806.TEST", "admin"), {
      clientLabel: "claude-ai",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.actorId).toBe(USERS.owner.id);
    expect(first.value.scope).toBe("admin");
    expect(first.value.allowCaeloAi).toBe(false);
    expect(first.value.via.kind).toBe("remote");
    expect(first.value.displayName).toBe(`Claude Code · ${USERS.owner.email}`);
    const again = await resolveRemoteMcpPrincipal(adapter, cred(USERS.owner.email, "admin"));
    expect(again.ok && again.value.via.kind === "remote" && again.value.via.connectionId).toBe(
      first.value.via.kind === "remote" ? first.value.via.connectionId : "",
    );
  });

  it("gates each surface by permission: admin needs settings.write, chat needs content.write", async () => {
    const editorAdmin = await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "admin"));
    expect(editorAdmin.ok).toBe(false);
    if (!editorAdmin.ok) {
      expect(editorAdmin.error.status).toBe(403);
      expect(editorAdmin.error.code).toBe("permission_denied");
      expect(editorAdmin.error.message).toContain("/api/mcp/chat");
      // #968 — names what is missing, the user's role and the roles that allow it.
      expect(editorAdmin.error.message).toContain("needs the settings.write permission");
      expect(editorAdmin.error.message).toContain("Your role (editor)");
      expect(editorAdmin.error.message).toContain("roles that do: owner");
    }
    // Refused requests create no row.
    expect(await connectionRow(USERS.editor.id, "admin")).toBeUndefined();
    expect((await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat"))).ok).toBe(
      true,
    );
    const reviewerChat = await resolveRemoteMcpPrincipal(
      adapter,
      cred(USERS.reviewer.email, "chat"),
    );
    expect(!reviewerChat.ok && reviewerChat.error.code).toBe("permission_denied");
  });

  it("refuses unknown, role-less and deleted users as not_a_caelo_user", async () => {
    for (const email of ["nobody@t806.test", USERS.roleless.email, USERS.deleted.email]) {
      const r = await resolveRemoteMcpPrincipal(adapter, cred(email, "chat"));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.status).toBe(403);
        expect(r.error.code).toBe("not_a_caelo_user");
      }
    }
  });

  it("maps identity failures to 401 and a missing audience to 503", async () => {
    const missing = await resolveRemoteMcpPrincipal(adapter, {
      iapCredential: "",
      surface: "chat",
      client: CLAUDE_CODE,
    });
    expect(!missing.ok && [missing.error.status, missing.error.code]).toEqual([
      401,
      "missing_iap_assertion",
    ]);
    const forged = await resolveRemoteMcpPrincipal(adapter, {
      iapCredential: signIapTestAssertion(iapTestKeyPair(KEY.kid), {
        aud: AUDIENCE,
        email: USERS.owner.email,
      }),
      surface: "admin",
      client: CLAUDE_CODE,
    });
    expect(!forged.ok && [forged.error.status, forged.error.code]).toEqual([
      401,
      "invalid_iap_assertion",
    ]);
    audience = undefined;
    try {
      const off = await resolveRemoteMcpPrincipal(adapter, cred(USERS.owner.email, "admin"));
      expect(!off.ok && [off.error.status, off.error.code]).toEqual([
        503,
        "remote_mcp_not_configured",
      ]);
    } finally {
      audience = AUDIENCE;
    }
  });

  it("keeps a revocation sticky until the Owner restores it", async () => {
    const before = await connectionRow(USERS.editor.id, "chat");
    expect(before).toBeDefined();
    const revoked = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.revoke", {
      id: before!.id,
    });
    expect(revoked.ok).toBe(true);
    for (let i = 0; i < 2; i++) {
      const r = await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat"));
      expect(!r.ok && [r.error.status, r.error.code]).toEqual([403, "remote_access_revoked"]);
    }
    // Never resurrected: still the same, still revoked row.
    const after = await connectionRow(USERS.editor.id, "chat");
    expect(after?.id).toBe(before!.id);
    expect(after?.revoked_at).not.toBeNull();
    const restored = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.restore", {
      id: before!.id,
    });
    expect(restored.ok).toBe(true);
    expect((await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat"))).ok).toBe(
      true,
    );
  });
});

describe("one connection per client app (#968)", () => {
  const editorCtx: ExecutionContext = {
    actorId: USERS.editor.id,
    actorKind: "human",
    requestId: "t968-editor",
  };

  it("revokes one app and leaves the same user's other app working", async () => {
    const claude = await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat"));
    const chatgpt = await resolveRemoteMcpPrincipal(
      adapter,
      cred(USERS.editor.email, "chat", CHATGPT),
    );
    expect(claude.ok && chatgpt.ok).toBe(true);
    const claudeRow = await connectionRow(USERS.editor.id, "chat");
    const chatgptRow = await connectionRow(USERS.editor.id, "chat", CHATGPT);
    expect(claudeRow?.id).toBeDefined();
    expect(chatgptRow?.id).not.toBe(claudeRow?.id);

    const revoked = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.revoke", {
      id: claudeRow!.id,
    });
    expect(revoked.ok).toBe(true);
    const refused = await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat"));
    expect(!refused.ok && refused.error.code).toBe("remote_access_revoked");
    if (!refused.ok) {
      // Who, and where to restore it — and that the other apps still work.
      expect(refused.error.message).toContain(`by ${USERS.owner.email}`);
      expect(refused.error.message).toContain("Settings → MCP");
      expect(refused.error.message).toContain("other connected apps are not affected");
    }
    expect(
      (await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat", CHATGPT))).ok,
    ).toBe(true);

    const list = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.list", {});
    const rows = list.ok
      ? (
          list.value as {
            connections: { id: string; clientName: string; revokedBy: string | null }[];
          }
        ).connections
      : [];
    expect(rows.find((r) => r.id === claudeRow!.id)).toMatchObject({
      clientName: "Claude Code",
      revokedBy: USERS.owner.email,
    });
    expect(rows.find((r) => r.id === chatgptRow!.id)?.clientName).toBe("ChatGPT");

    await execute(registry, adapter, ownerCtx, "mcp_remote_connections.restore", {
      id: claudeRow!.id,
    });
  });

  it("blocks every app of a user, new apps included, until the Owner unblocks", async () => {
    const editorBlock = await execute(
      registry,
      adapter,
      editorCtx,
      "mcp_remote_connections.block_user",
      { actorId: USERS.owner.id },
    );
    expect(message(editorBlock)).toContain("only an Owner");

    const blocked = await execute(
      registry,
      adapter,
      ownerCtx,
      "mcp_remote_connections.block_user",
      {
        actorId: USERS.editor.id,
      },
    );
    expect(blocked.ok).toBe(true);
    for (const client of [CLAUDE_CODE, CHATGPT, "dcr:Never Seen Before"]) {
      const r = await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat", client));
      expect(!r.ok && [r.error.status, r.error.code]).toEqual([403, "remote_access_blocked"]);
      if (!r.ok) expect(r.error.message).toContain(`by ${USERS.owner.email}`);
    }
    // A blocked request creates no row for the new app.
    expect(await connectionRow(USERS.editor.id, "chat", "dcr:Never Seen Before")).toBeUndefined();
    // The editor sees their own block, read-only.
    const own = await execute(registry, adapter, editorCtx, "mcp_remote_connections.list", {});
    expect(own.ok && (own.value as { blocks: { actorId: string }[] }).blocks).toEqual([
      expect.objectContaining({ actorId: USERS.editor.id }),
    ]);
    expect(
      message(
        await execute(registry, adapter, editorCtx, "mcp_remote_connections.unblock_user", {
          actorId: USERS.editor.id,
        }),
      ),
    ).toContain("only an Owner");

    const unblocked = await execute(
      registry,
      adapter,
      ownerCtx,
      "mcp_remote_connections.unblock_user",
      { actorId: USERS.editor.id },
    );
    expect(unblocked.ok).toBe(true);
    expect((await resolveRemoteMcpPrincipal(adapter, cred(USERS.editor.email, "chat"))).ok).toBe(
      true,
    );
  });

  it("hands a pre-#968 row to the app that last used it, and only to that app", async () => {
    // The viu.one case: one per-user row labelled by Claude Code, revoked.
    const legacyId = await withSql(async (tx) => {
      const rows = (await tx`
        INSERT INTO mcp_remote_connections (actor_id, surface, client_label, revoked_at, ai_cost_cap_microcents)
        VALUES (${USERS.owner.id}::uuid, 'chat', 'claude-code', now(), 42)
        RETURNING id::text AS id`) as { id: string }[];
      return rows[0]!.id;
    });
    // ChatGPT is a different app: it gets its own, working row.
    const chatgpt = await resolveRemoteMcpPrincipal(
      adapter,
      cred(USERS.owner.email, "chat", CHATGPT),
      { clientLabel: "openai-mcp" },
    );
    expect(chatgpt.ok).toBe(true);
    expect(
      chatgpt.ok && chatgpt.value.via.kind === "remote" && chatgpt.value.via.connectionId,
    ).not.toBe(legacyId);
    // Claude Code's initialize names the row's client: it takes the row over, revocation and all.
    const claude = await resolveRemoteMcpPrincipal(adapter, cred(USERS.owner.email, "chat"), {
      clientLabel: "claude-code",
    });
    expect(!claude.ok && claude.error.code).toBe("remote_access_revoked");
    expect((await connectionRow(USERS.owner.id, "chat"))?.id).toBe(legacyId);
    await execute(registry, adapter, ownerCtx, "mcp_remote_connections.restore", { id: legacyId });
    const restored = await resolveRemoteMcpPrincipal(adapter, cred(USERS.owner.email, "chat"));
    expect(restored.ok && restored.value.aiCostCapMicrocents).toBe(42);
    // Uncapped again for the op tests below.
    await execute(registry, adapter, ownerCtx, "mcp_remote_connections.set_cap", {
      id: legacyId,
      aiCostCapMicrocents: null,
    });
  });
});

describe("mcp_remote_connections ops", () => {
  it("lists every connection with the user's email for the Owner, never for the AI", async () => {
    const r = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.list", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = (
      r.value as {
        connections: { email: string | null; surface: string; clientLabel: string | null }[];
      }
    ).connections;
    const owner = rows.find((c) => c.email === USERS.owner.email && c.surface === "admin");
    expect(owner?.clientLabel).toBe("claude-ai");
    expect(rows.some((c) => c.email === USERS.editor.email && c.surface === "chat")).toBe(true);
    const ai = await execute(
      registry,
      adapter,
      { ...ownerCtx, actorKind: "ai" },
      "mcp_remote_connections.list",
      {},
    );
    expect(ai.ok).toBe(false);
  });

  it("shows a non-Owner only their own connections and lets them change none (0322)", async () => {
    const editorCtx: ExecutionContext = {
      actorId: USERS.editor.id,
      actorKind: "human",
      requestId: "t806-editor",
    };
    const r = await execute(registry, adapter, editorCtx, "mcp_remote_connections.list", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = (r.value as { connections: { actorId: string; email: string | null }[] })
      .connections;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.actorId === USERS.editor.id)).toBe(true);
    expect(rows.some((c) => c.email === USERS.owner.email)).toBe(false);

    const ownersRow = await connectionRow(USERS.owner.id, "admin");
    const ownRow = await connectionRow(USERS.editor.id, "chat");
    for (const id of [ownersRow!.id, ownRow!.id]) {
      const revoke = await execute(registry, adapter, editorCtx, "mcp_remote_connections.revoke", {
        id,
      });
      expect(message(revoke)).toContain("not yours to change");
      const cap = await execute(registry, adapter, editorCtx, "mcp_remote_connections.set_cap", {
        id,
        aiCostCapMicrocents: 1,
      });
      expect(message(cap)).toContain("not yours to change");
    }
    expect((await connectionRow(USERS.owner.id, "admin"))?.revoked_at).toBeNull();
    expect((await connectionRow(USERS.editor.id, "chat"))?.revoked_at).toBeNull();
  });

  it("sets the cap and allowCaeloAi on admin connections; refuses allowCaeloAi on chat", async () => {
    const admin = await connectionRow(USERS.owner.id, "admin");
    const set = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.set_cap", {
      id: admin!.id,
      aiCostCapMicrocents: 5_000_000,
      allowCaeloAi: true,
    });
    expect(set.ok).toBe(true);
    const p = await resolveRemoteMcpPrincipal(adapter, cred(USERS.owner.email, "admin"));
    expect(p.ok && [p.value.aiCostCapMicrocents, p.value.allowCaeloAi]).toEqual([5_000_000, true]);

    const chat = await connectionRow(USERS.editor.id, "chat");
    const refused = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.set_cap", {
      id: chat!.id,
      aiCostCapMicrocents: null,
      allowCaeloAi: true,
    });
    expect(message(refused)).toContain("admin-surface connections only");

    // Back to the default for the op tests below.
    await execute(registry, adapter, ownerCtx, "mcp_remote_connections.set_cap", {
      id: admin!.id,
      aiCostCapMicrocents: null,
      allowCaeloAi: false,
    });
  });
});

describe("mcp.* ops on a remote credential", () => {
  it("serves the Power-MCP catalogue to the admin connection and refuses a chat credential", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.list_tools", {
      remote: cred(USERS.owner.email, "admin"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = (r.value as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(names).toContain("list_pages");
      expect(names).not.toContain("spawn_subagents");
    }
    const chat = await execute(registry, adapter, systemCtx, "mcp.list_tools", {
      remote: cred(USERS.editor.email, "chat"),
    });
    expect(message(chat)).toMatch(/^auth_error: mcp\.list_tools belongs to the admin surface/);
  });

  it("refuses a request carrying both credentials, or neither", async () => {
    const both = await execute(registry, adapter, systemCtx, "mcp.list_tools", {
      remote: cred(USERS.owner.email, "admin"),
      plaintextToken: "mcp_000000000000",
    });
    expect(both.ok).toBe(false);
    const neither = await execute(registry, adapter, systemCtx, "mcp.list_tools", {});
    expect(neither.ok).toBe(false);
  });

  it("opens a session, persists it on the connection, and attributes tool calls to the connection", async () => {
    const remote = cred(USERS.owner.email, "admin");
    const opened = await execute(registry, adapter, systemCtx, "mcp.open_session", {
      remote,
      newSession: true,
      title: "t806 remote session",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { chatSessionId } = opened.value as { chatSessionId: string };
    const row = await connectionRow(USERS.owner.id, "admin");
    expect(row?.current).toBe(chatSessionId);

    const p = await resolveRemoteMcpPrincipal(adapter, remote);
    expect(p.ok && p.value.via.kind === "remote" && p.value.via.currentChatSessionId).toBe(
      chatSessionId,
    );

    const exec = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      remote,
      chatSessionId,
      toolName: "list_pages",
    });
    expect(exec.ok).toBe(true);
    if (exec.ok) expect((exec.value as { ok: boolean }).ok).toBe(true);
    const runs = await withSql(
      async (tx) =>
        (await tx`SELECT mcp_token_id, mcp_remote_connection_id::text AS conn, label
                  FROM chat_agent_runs WHERE chat_session_id = ${chatSessionId}::uuid AND kind = 'mcp'`) as {
          mcp_token_id: string | null;
          conn: string | null;
          label: string;
        }[],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.mcp_token_id).toBeNull();
    expect(runs[0]?.conn).toBe(row!.id);
    expect(runs[0]?.label).toContain("(remote MCP)");
  });

  it("returns caelo_chat approval state for the connection's own cards only", async () => {
    const created = await execute(registry, adapter, ownerCtx, "chat.create_session", {
      title: "t806 chat approvals",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { chatSessionId } = created.value as { chatSessionId: string };
    // The owner's chat connection (auto-created on first use).
    const p = await resolveRemoteMcpPrincipal(adapter, cred(USERS.owner.email, "chat"));
    expect(p.ok).toBe(true);
    if (!p.ok || p.value.via.kind !== "remote") return;
    const recorded = await execute(registry, adapter, ownerCtx, "chat.record_turn_approvals", {
      chatSessionId,
      source: "mcp_chat",
      mcpRemoteConnectionId: p.value.via.connectionId,
      approvals: [
        {
          approvalId: "t806-approval-1",
          toolCallId: "t806-call-1",
          toolName: "propose_create_mcp_token",
          preview: "mint a token",
          requiredPermissions: [],
        },
      ],
    });
    expect(recorded.ok).toBe(true);

    const state = await execute(registry, adapter, systemCtx, "mcp.get_chat_approval_state", {
      remote: cred(USERS.owner.email, "chat"),
      chatSessionId,
    });
    expect(state.ok).toBe(true);
    if (state.ok) {
      const v = state.value as { state: string; approvals: { approvalId: string }[] };
      expect(v.state).toBe("pending");
      expect(v.approvals.map((a) => a.approvalId)).toEqual(["t806-approval-1"]);
    }

    // A token of the same user is a different agent: it sees none of them.
    const minted = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
      displayName: "t806 token",
    });
    if (!minted.ok) throw new Error("mint failed");
    const tokenState = await execute(registry, adapter, systemCtx, "mcp.get_chat_approval_state", {
      plaintextToken: (minted.value as { plaintextToken: string }).plaintextToken,
      chatSessionId,
    });
    expect(tokenState.ok && (tokenState.value as { state: string }).state).toBe("none");

    // A card names exactly one agent.
    const both = await execute(registry, adapter, ownerCtx, "chat.record_turn_approvals", {
      chatSessionId,
      source: "mcp_chat",
      mcpRemoteConnectionId: p.value.via.connectionId,
      mcpTokenId: (minted.value as { id: string }).id,
      approvals: [
        {
          approvalId: "t806-approval-2",
          toolCallId: "t806-call-2",
          toolName: "x",
          preview: "y",
          requiredPermissions: [],
        },
      ],
    });
    expect(both.ok).toBe(false);
  });

  it("authorises uploads for either surface by the user's current content.write", async () => {
    const ok = await execute(registry, adapter, systemCtx, "mcp.authorize_upload", {
      remote: cred(USERS.editor.email, "chat"),
    });
    expect(ok.ok && (ok.value as { actorId: string }).actorId).toBe(USERS.editor.id);
  });
});
