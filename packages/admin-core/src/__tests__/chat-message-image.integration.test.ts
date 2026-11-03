// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #359 — `chat.get_message_image` resolves the stored object of a
 * tool-produced chat image for the transcript route, and only for the
 * chat's owner. It answers with the key the message row holds, never one
 * the client names, and refuses anything that is not a well-formed
 * chat-image key (an operator upload, a tampered row pointing elsewhere).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { buildChatImageKey, type ChatAttachment, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const owner: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000359",
  actorKind: "human",
  requestId: "issue359-owner",
};
const other: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000360",
  actorKind: "human",
  requestId: "issue359-other",
};

const KEY = buildChatImageKey("2026-11-03", "b".repeat(64), "webp");

async function ensureEditor(actorId: string): Promise<void> {
  const db = new SQL(ADMIN_URL as string);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${actorId}::uuid, 'human', ${`issue359 ${actorId.slice(-4)}`})
               ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${actorId}::uuid, ${`${actorId}@issue359.test`}, 'test-only')
               ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${actorId}::uuid, id FROM roles WHERE name = 'editor'
               ON CONFLICT DO NOTHING`;
    });
  } finally {
    await db.end();
  }
}

async function newSession(ctx: ExecutionContext): Promise<string> {
  const r = await execute(registry, adapter, ctx, "chat.create_session", { title: "issue359" });
  if (!r.ok) throw new Error(`create_session: ${JSON.stringify(r.error)}`);
  return (r.value as { chatSessionId: string }).chatSessionId;
}

/** Append a row (a tool row by default) carrying `attachments`; returns its id. */
async function toolRow(
  chatSessionId: string,
  attachments: ChatAttachment[],
  role: "tool" | "user" = "tool",
): Promise<string> {
  const r = await execute(registry, adapter, owner, "chat.append_message", {
    chatSessionId,
    role,
    content: "Screenshot captured.",
    ...(role === "tool" ? { toolCallId: `tc-${crypto.randomUUID()}` } : {}),
    attachments,
  });
  if (!r.ok) throw new Error(`append_message: ${JSON.stringify(r.error)}`);
  return (r.value as { messageId: string }).messageId;
}

function resolve(ctx: ExecutionContext, chatSessionId: string, messageId: string, index = 0) {
  return execute(registry, adapter, ctx, "chat.get_message_image", {
    chatSessionId,
    messageId,
    index,
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureEditor(owner.actorId);
  await ensureEditor(other.actorId);
});

afterAll(async () => {
  await adapter.close();
});

describe("chat.get_message_image (#359)", () => {
  it("returns the stored key and type to the chat's owner", async () => {
    const chat = await newSession(owner);
    const messageId = await toolRow(chat, [{ storageKey: KEY, mime: "image/webp" }]);
    const r = await resolve(owner, chat, messageId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ storageKey: KEY, mime: "image/webp" });
  });

  it("reads as not found for another user, another chat, or a missing index", async () => {
    const chat = await newSession(owner);
    const messageId = await toolRow(chat, [{ storageKey: KEY, mime: "image/webp" }]);
    const otherChat = await newSession(other);

    expect((await resolve(other, chat, messageId)).ok).toBe(false);
    // The message exists, but not in the chat the URL names.
    expect((await resolve(owner, otherChat, messageId)).ok).toBe(false);
    expect((await resolve(other, otherChat, messageId)).ok).toBe(false);
    expect((await resolve(owner, chat, messageId, 1)).ok).toBe(false);
    expect((await resolve(owner, chat, crypto.randomUUID())).ok).toBe(false);
  });

  it("answers only for a well-formed chat-image key, never an upload or a foreign path", async () => {
    const chat = await newSession(owner);
    const upload = await toolRow(chat, [{ assetId: crypto.randomUUID(), mime: "image/png" }]);
    expect((await resolve(owner, chat, upload)).ok).toBe(false);

    for (const storageKey of [
      `chat-images/../${"b".repeat(64)}.png`,
      `${"b".repeat(64)}/orig.png`,
      "plugins/secret/config.json",
    ]) {
      const tampered = await toolRow(chat, [{ storageKey, mime: "image/png" }]);
      const r = await resolve(owner, chat, tampered);
      expect(r.ok).toBe(false);
    }
  });

  it("never answers for a user row, whose attachments come from the client", async () => {
    const chat = await newSession(owner);
    const userRow = await toolRow(chat, [{ storageKey: KEY, mime: "image/webp" }], "user");
    expect((await resolve(owner, chat, userRow)).ok).toBe(false);
  });

  it("rejects an index beyond the attachment cap at the boundary", async () => {
    const chat = await newSession(owner);
    const messageId = await toolRow(chat, [{ storageKey: KEY, mime: "image/webp" }]);
    const r = await resolve(owner, chat, messageId, 4);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ValidationFailed");
  });
});
