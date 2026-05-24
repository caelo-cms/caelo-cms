// SPDX-License-Identifier: MPL-2.0

/**
 * PR #61 follow-up — chat.append_message must NOT FK-violate when the
 * chat_sessions row vanished mid-stream.
 *
 * The step 13 e2e walk on PR #61 surfaced 3+ red
 * `chat_messages_chat_session_id_fkey` "Failed query" lines in
 * admin.log when scenario N's chat-runner raced scenario N+1's
 * `resetLiveditFixtures()` truncating chat_sessions. The orphan
 * INSERTs come from the runner's async post-stream persistence loop
 * still trying to write turns for a session that no longer exists.
 *
 * Same race can hit production: a user clicks Discard / a cascade
 * fires from user-delete / an Owner clears stale sessions while one
 * is actively running.
 *
 * Fix: chat.append_message uses `INSERT ... SELECT ... WHERE EXISTS
 * (chat_sessions ...)` so the FK never fires, and returns a soft
 * `session_gone` HandlerError the chat-runner downgrades to a
 * console.warn instead of a red console.error + SSE error banner.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "pr61-session-gone",
};

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

async function makeSession(): Promise<string> {
  const result = await execute(registry, adapter, SYSTEM, "chat.create_session", {
    title: "pr61-session-gone",
  });
  if (!result.ok) {
    throw new Error(`makeSession: ${JSON.stringify(result.error)}`);
  }
  return (result.value as { chatSessionId: string }).chatSessionId;
}

async function deleteSession(id: string): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id = ${id}::uuid`;
      await tx`DELETE FROM chat_sessions WHERE id = ${id}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

describe("chat.append_message — session-gone race", () => {
  it("returns the `session_gone` soft error (NOT an FK violation) when the chat_sessions row is missing", async () => {
    const sessionId = await makeSession();
    // Simulate the race: session is deleted before the runner's
    // async write lands.
    await deleteSession(sessionId);

    const result = await execute(registry, adapter, SYSTEM, "chat.append_message", {
      chatSessionId: sessionId,
      role: "assistant",
      content: "this assistant message races a session-delete",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("HandlerError");
    if (result.error.kind !== "HandlerError") throw new Error("unreachable");
    // Sentinel the chat-runner pattern-matches on to downgrade the
    // red console.error + SSE error banner.
    expect(result.error.message).toMatch(/^session_gone:/);
  });

  it("still writes successfully when the session DOES exist", async () => {
    const sessionId = await makeSession();
    try {
      const result = await execute(registry, adapter, SYSTEM, "chat.append_message", {
        chatSessionId: sessionId,
        role: "assistant",
        content: "happy-path write",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect((result.value as { messageId: string }).messageId).toMatch(
        /^[0-9a-f-]{36}$/i,
      );
    } finally {
      await deleteSession(sessionId);
    }
  });
});
