// SPDX-License-Identifier: MPL-2.0

/**
 * MCP tokens are visible per user: an Owner (settings.write) sees and
 * revokes every user's token; everyone else sees and revokes only their
 * own. The scope lives in the mcp_tokens RLS policy (migration 0315), so
 * every read — the list op, revoke, the AI's propose_revoke preview —
 * inherits it. The AI follows the person whose chat it acts in.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
const registry = new OperationRegistry();
registerAdminOps(registry);

function human(name: string): ExecutionContext {
  return { actorId: crypto.randomUUID(), actorKind: "human", requestId: `mcp-scope-${name}` };
}
const OWNER = human("owner");
const EDITOR = human("editor");
const REVIEWER = human("reviewer");
const AI_ACTOR = "00000000-0000-0000-0000-000000000a1a";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-scope-system",
};

const tokenOf: Record<string, string> = {};

async function seedUser(ctx: ExecutionContext, role: string): Promise<void> {
  const db = new SQL(ADMIN_URL!);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${ctx.actorId}::uuid, 'human', ${role})`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${ctx.actorId}::uuid, ${`${ctx.actorId}@example.test`}, 'unused')`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${ctx.actorId}::uuid, id FROM roles WHERE name = ${role}`;
    });
  } finally {
    await db.end();
  }
}

async function mint(ctx: ExecutionContext, displayName: string): Promise<string> {
  const r = await execute(registry, adapter, ctx, "mcp_tokens.create", { displayName });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { id: string }).id;
}

async function list(ctx: ExecutionContext) {
  const r = await execute(registry, adapter, ctx, "mcp_tokens.list", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as { visibility: string; tokens: Array<{ id: string; actorId: string }> };
}

async function revokedAt(id: string): Promise<string | null> {
  const db = new SQL(ADMIN_URL!);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx`SELECT revoked_at FROM mcp_tokens WHERE id = ${id}::uuid`;
      return (rows[0]?.revoked_at as string | null) ?? null;
    });
  } finally {
    await db.end();
  }
}

function errorMessage(r: { ok: boolean; error?: unknown }): string {
  const e = r.error as { message?: string } | undefined;
  return e?.message ?? "";
}

async function chatOf(ctx: ExecutionContext): Promise<ExecutionContext> {
  const r = await execute(registry, adapter, ctx, "chat.create_session", { title: "mcp scope" });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const v = r.value as { chatSessionId: string; chatBranchId: string };
  return {
    actorId: AI_ACTOR,
    actorKind: "ai",
    requestId: `mcp-scope-ai-${ctx.requestId}`,
    chatTaskId: v.chatSessionId,
    chatBranchId: v.chatBranchId,
  };
}

beforeAll(async () => {
  await seedUser(OWNER, "owner");
  await seedUser(EDITOR, "editor");
  await seedUser(REVIEWER, "reviewer");
  const db = new SQL(ADMIN_URL!);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI_ACTOR}::uuid, 'ai', 'AI')
               ON CONFLICT (id) DO NOTHING`;
    });
  } finally {
    await db.end();
  }
  tokenOf.owner = await mint(OWNER, "owner-laptop");
  tokenOf.editor = await mint(EDITOR, "editor-laptop");
  tokenOf.reviewer = await mint(REVIEWER, "reviewer-laptop");
});

afterAll(async () => {
  await adapter.close();
});

describe("mcp_tokens.list", () => {
  it("shows an Owner every user's tokens", async () => {
    const v = await list(OWNER);
    expect(v.visibility).toBe("all");
    const ids = v.tokens.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([tokenOf.owner, tokenOf.editor, tokenOf.reviewer] as string[]),
    );
  });

  it("shows an editor only their own tokens", async () => {
    const v = await list(EDITOR);
    expect(v.tokens.map((t) => t.id)).toEqual([tokenOf.editor as string]);
    expect(v.visibility).toBe("own");
  });

  it("shows a reviewer only their own tokens", async () => {
    const v = await list(REVIEWER);
    expect(v.tokens.map((t) => t.id)).toEqual([tokenOf.reviewer as string]);
    expect(v.visibility).toBe("own");
  });
});

describe("mcp_tokens.revoke", () => {
  it("refuses a non-Owner revoking another user's token, with the next step", async () => {
    const r = await execute(registry, adapter, EDITOR, "mcp_tokens.revoke", {
      id: tokenOf.reviewer,
    });
    expect(r.ok).toBe(false);
    expect(errorMessage(r)).toContain("not found among the MCP tokens you can manage");
    expect(errorMessage(r)).toContain("settings.write");
    expect(await revokedAt(tokenOf.reviewer as string)).toBeNull();
  });

  it("lets a non-Owner revoke their own token", async () => {
    const own = await mint(REVIEWER, "reviewer-ci");
    const r = await execute(registry, adapter, REVIEWER, "mcp_tokens.revoke", { id: own });
    expect(r.ok).toBe(true);
    expect(await revokedAt(own)).not.toBeNull();
  });

  it("lets an Owner revoke another user's token", async () => {
    const victim = await mint(EDITOR, "editor-ci");
    const r = await execute(registry, adapter, OWNER, "mcp_tokens.revoke", { id: victim });
    expect(r.ok).toBe(true);
    expect(await revokedAt(victim)).not.toBeNull();
  });

  it("names an unknown token the same way as another user's", async () => {
    const r = await execute(registry, adapter, OWNER, "mcp_tokens.revoke", {
      id: crypto.randomUUID(),
    });
    expect(r.ok).toBe(false);
    expect(errorMessage(r)).toContain("not found among the MCP tokens you can manage");
  });
});

describe("the AI follows the person whose chat it acts in", () => {
  it("cannot propose revoking another user's token from an editor's chat", async () => {
    const ai = await chatOf(EDITOR);
    const r = await execute(registry, adapter, ai, "mcp_tokens.propose_revoke", {
      tokenId: tokenOf.owner,
    });
    expect(r.ok).toBe(false);
    expect(errorMessage(r)).toContain("not found among the MCP tokens you can manage");
  });

  it("can propose revoking any user's token from an Owner's chat", async () => {
    const ai = await chatOf(OWNER);
    const r = await execute(registry, adapter, ai, "mcp_tokens.propose_revoke", {
      tokenId: tokenOf.editor,
    });
    expect(r.ok).toBe(true);
    expect((r as { value: { preview: { displayName: string } } }).value.preview.displayName).toBe(
      "editor-laptop",
    );
  });

  it("system still sees every token (token resolution, workers)", async () => {
    const v = await list(SYSTEM);
    expect(v.visibility).toBe("all");
    expect(v.tokens.length).toBeGreaterThanOrEqual(3);
  });
});
