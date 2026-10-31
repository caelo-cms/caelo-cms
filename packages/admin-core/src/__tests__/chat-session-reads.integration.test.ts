// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — session reads load only what their caller needs.
 *
 *   - `chat.resolve_session` returns the session row alone (owner-scoped);
 *   - `chat.get_session` leaves the SDK `response_messages` out unless the
 *     caller asks (only the chat runner replays them) and pages the history
 *     (newest page, `before` cursor, `hasMore`);
 *   - `mcp.execute_tool` and `mcp.open_session` resolve the session without
 *     ever running `chat.get_session` — an MCP tool call used to load the
 *     whole transcript just to read the branch id (an admin instance was
 *     OOM-killed during one).
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
/** Every op name `execute` looked up since the last reset. */
let lookedUp: string[] = [];

const owner: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001216",
  actorKind: "human",
  requestId: "issue1216-owner",
};
const other: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001217",
  actorKind: "human",
  requestId: "issue1216-other",
};
const system: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue1216-system",
};

async function ensureEditor(actorId: string): Promise<void> {
  const db = new SQL(ADMIN_URL as string);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${actorId}::uuid, 'human', ${`issue1216 ${actorId.slice(-4)}`})
               ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${actorId}::uuid, ${`${actorId}@issue1216.test`}, 'test-only')
               ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${actorId}::uuid, id FROM roles WHERE name = 'editor'
               ON CONFLICT DO NOTHING`;
    });
  } finally {
    await db.end();
  }
}

async function newSession(ctx: ExecutionContext, title: string): Promise<string> {
  const r = await execute(registry, adapter, ctx, "chat.create_session", { title });
  if (!r.ok) throw new Error(`create_session: ${JSON.stringify(r.error)}`);
  return (r.value as { chatSessionId: string }).chatSessionId;
}

async function append(
  chatSessionId: string,
  role: "user" | "assistant",
  content: string,
  responseMessages?: unknown[],
): Promise<void> {
  const r = await execute(registry, adapter, owner, "chat.append_message", {
    chatSessionId,
    role,
    content,
    ...(responseMessages ? { responseMessages } : {}),
  });
  if (!r.ok) throw new Error(`append_message: ${JSON.stringify(r.error)}`);
}

type Page = {
  messages: { id: string; content: string; responseMessages: unknown[] | null }[];
  hasMore: boolean;
};

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // Record every op `execute` resolves — nested executes inside the MCP ops
  // go through the same registry instance (the bridge holds it).
  const lookup = registry.lookup.bind(registry);
  registry.lookup = (name: string) => {
    lookedUp.push(name);
    return lookup(name);
  };
  await ensureEditor(owner.actorId);
  await ensureEditor(other.actorId);
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
});

afterAll(async () => {
  await adapter.close();
});

describe("chat.resolve_session (#1216)", () => {
  it("returns the session row without history, only to its owner", async () => {
    const id = await newSession(owner, "issue1216 resolve");
    await append(id, "user", "hello");
    const r = await execute(registry, adapter, owner, "chat.resolve_session", {
      chatSessionId: id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as Record<string, unknown> & {
      session: { id: string; chatBranchId: string; archivedAt: string | null; createdBy: string };
    };
    expect(Object.keys(v)).toEqual(["session"]);
    expect(v.session.id).toBe(id);
    expect(v.session.createdBy).toBe(owner.actorId);
    expect(v.session.chatBranchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.session.archivedAt).toBeNull();

    const foreign = await execute(registry, adapter, other, "chat.resolve_session", {
      chatSessionId: id,
    });
    expect(foreign.ok).toBe(false);
  });
});

describe("chat.get_session (#1216)", () => {
  it("leaves response_messages out unless the caller asks for them", async () => {
    const id = await newSession(owner, "issue1216 response messages");
    await append(id, "user", "go");
    const sdk = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
    await append(id, "assistant", "done", sdk);

    const plain = await execute(registry, adapter, owner, "chat.get_session", {
      chatSessionId: id,
    });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const plainMsgs = (plain.value as Page).messages;
    expect(plainMsgs.map((m) => m.content)).toEqual(["go", "done"]);
    expect(plainMsgs.every((m) => m.responseMessages === null)).toBe(true);

    const full = await execute(registry, adapter, owner, "chat.get_session", {
      chatSessionId: id,
      includeResponseMessages: true,
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect((full.value as Page).messages[1]?.responseMessages).toEqual(sdk);
  });

  it("pages the history newest-first with a before cursor and hasMore", async () => {
    const id = await newSession(owner, "issue1216 paging");
    for (let i = 0; i < 5; i++) await append(id, i % 2 === 0 ? "user" : "assistant", `m${i}`);

    const all = await execute(registry, adapter, owner, "chat.get_session", { chatSessionId: id });
    if (!all.ok) throw new Error("full read failed");
    expect((all.value as Page).hasMore).toBe(false);
    expect((all.value as Page).messages.map((m) => m.content)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);

    const newest = await execute(registry, adapter, owner, "chat.get_session", {
      chatSessionId: id,
      limit: 2,
    });
    if (!newest.ok) throw new Error("page 1 failed");
    const p1 = newest.value as Page;
    expect(p1.messages.map((m) => m.content)).toEqual(["m3", "m4"]);
    expect(p1.hasMore).toBe(true);

    const older = await execute(registry, adapter, owner, "chat.get_session", {
      chatSessionId: id,
      limit: 2,
      before: p1.messages[0]?.id,
    });
    if (!older.ok) throw new Error("page 2 failed");
    const p2 = older.value as Page;
    expect(p2.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(p2.hasMore).toBe(true);

    const oldest = await execute(registry, adapter, owner, "chat.get_session", {
      chatSessionId: id,
      limit: 2,
      before: p2.messages[0]?.id,
    });
    if (!oldest.ok) throw new Error("page 3 failed");
    expect((oldest.value as Page).messages.map((m) => m.content)).toEqual(["m0"]);
    expect((oldest.value as Page).hasMore).toBe(false);
  });

  it("keeps rows saved in one transaction in write order (0401)", async () => {
    // One transaction = one `created_at` for every row. Ordering ties by the
    // random uuid shuffled them (e2e chat-status-notes); `seq` keeps the
    // order they were written in, for the full read and every page.
    const id = await newSession(owner, "issue1216 same-transaction order");
    const written = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const db = new SQL(ADMIN_URL as string);
    try {
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        for (const content of written) {
          await tx`INSERT INTO chat_messages (chat_session_id, role, content, origin, status)
                   VALUES (${id}::uuid, 'user', ${content}, 'system', 'complete')`;
        }
      });
    } finally {
      await db.end();
    }

    const all = await execute(registry, adapter, owner, "chat.get_session", { chatSessionId: id });
    if (!all.ok) throw new Error("full read failed");
    expect((all.value as Page).messages.map((m) => m.content)).toEqual(written);

    const paged: string[] = [];
    let before: string | undefined;
    for (;;) {
      const r = await execute(registry, adapter, owner, "chat.get_session", {
        chatSessionId: id,
        limit: 5,
        ...(before ? { before } : {}),
      });
      if (!r.ok) throw new Error("paged read failed");
      const page = r.value as Page;
      paged.unshift(...page.messages.map((m) => m.content));
      if (!page.hasMore) break;
      before = page.messages[0]?.id;
    }
    expect(paged).toEqual(written);
  });

  it("refuses a before cursor without a limit, naming both parameters", async () => {
    const id = await newSession(owner, "issue1216 cursor");
    const r = await execute(registry, adapter, owner, "chat.get_session", {
      chatSessionId: id,
      before: crypto.randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("message" in r.error ? r.error.message : "").toContain("needs `limit`");
  });
});

describe("Power-MCP session lookups (#1216)", () => {
  let token: string;
  let chatSessionId: string;

  beforeAll(async () => {
    const r = await execute(registry, adapter, owner, "mcp_tokens.create", {
      displayName: "issue1216-admin",
      scope: "admin",
    });
    if (!r.ok) throw new Error(`token: ${JSON.stringify(r.error)}`);
    token = (r.value as { plaintextToken: string }).plaintextToken;
    const opened = await execute(registry, adapter, system, "mcp.open_session", {
      plaintextToken: token,
      title: "issue1216 mcp",
    });
    if (!opened.ok) throw new Error(`open_session: ${JSON.stringify(opened.error)}`);
    chatSessionId = (opened.value as { chatSessionId: string }).chatSessionId;
    await append(chatSessionId, "user", "a transcript the tool call must not load");
  });

  it("execute_tool resolves the branch without reading the chat history", async () => {
    lookedUp = [];
    const r = await execute(registry, adapter, system, "mcp.execute_tool", {
      plaintextToken: token,
      chatSessionId,
      toolName: "list_pages",
      args: {},
    });
    expect(r.ok).toBe(true);
    // #1253 — the session row is read inside mcp.begin_tool_call.
    expect(lookedUp).toContain("mcp.begin_tool_call");
    expect(lookedUp).not.toContain("chat.get_session");
  });

  it("open_session resumes by id without reading the chat history", async () => {
    lookedUp = [];
    const r = await execute(registry, adapter, system, "mcp.open_session", {
      plaintextToken: token,
      chatSessionId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { resumed: boolean }).resumed).toBe(true);
    expect(lookedUp).toContain("chat.resolve_session");
    expect(lookedUp).not.toContain("chat.get_session");
  });
});
