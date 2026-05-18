// SPDX-License-Identifier: MPL-2.0

/**
 * v0.8.0 — chat.list_open_with_pending powers the /edit toolbar's
 * cross-chat awareness banner. When the operator is editing page A
 * and has unstaged work on chat-2 anchored to page B, this op should
 * return chat-2 (with its title + anchor page slug + pending count)
 * so the banner reminds them to come back and stage it.
 *
 * The op must also EXCLUDE the chat currently in scope (so the banner
 * doesn't tell the operator "you have changes on the page you're
 * already editing"). And it must include layout-chrome edits in the
 * count, so a chat whose only branch activity was add_module_to_layout
 * still surfaces in the banner (pre-v0.8 those edits were invisible).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const AI = "00000000-0000-0000-0000-000000000a1a";
const humanCtx: ExecutionContext = {
  actorId: HUMAN,
  actorKind: "system",
  requestId: "cross-chat",
};
const aiCtx: ExecutionContext = { actorId: AI, actorKind: "ai", requestId: "cross-chat" };

const PFX = "v080-cross-";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

class StepProvider extends FixtureProvider {
  readonly #queue: ProviderEvent[][];
  #idx = 0;
  constructor(q: ProviderEvent[][]) {
    super([], "claude-test-1");
    this.#queue = q;
  }
  override async *generate(): AsyncIterable<ProviderEvent> {
    const events = this.#queue[this.#idx] ?? [
      { kind: "done" as const, stopReason: "end_turn" as const },
    ];
    this.#idx++;
    for (const e of events) yield e;
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

describe("chat.list_open_with_pending", () => {
  it("returns other chats with branch activity; excludes the in-scope chat", async () => {
    // Seed module so each chat has something to edit.
    const created = await execute(registry, adapter, humanCtx, "modules.create", {
      slug: `${PFX}mod-a`,
      displayName: "A",
      html: "<p>v0</p>",
    });
    if (!created.ok) throw new Error("seed module");
    const moduleId = (created.value as { moduleId: string }).moduleId;

    // Two open chats. chat-A edits the module on its branch; chat-B
    // does not (so chat-B should NOT show up in the cross-chat banner
    // results — it has zero pending).
    const sA = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: `${PFX}A`,
    });
    const sB = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: `${PFX}B`,
    });
    if (!sA.ok || !sB.ok) throw new Error("seed sessions");
    const chatA = (sA.value as { chatSessionId: string }).chatSessionId;
    const chatB = (sB.value as { chatSessionId: string }).chatSessionId;

    // chat-A makes an edit so it has pending.
    const tools = createDefaultToolRegistry();
    const p = new StepProvider([
      [
        {
          kind: "tool-call",
          id: "t1",
          name: "edit_module",
          arguments: { moduleId, html: "<p>edited</p>" },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "ok" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);
    for await (const _ of runChatTurn(
      { adapter, registry, provider: p, tools, aiCtx, humanCtx },
      { chatSessionId: chatA, content: "edit it", chips: [] },
    )) {
      // drain
    }

    // Querying with chat-B excluded should return ONLY chat-A.
    const fromB = await execute(registry, adapter, humanCtx, "chat.list_open_with_pending", {
      excludeChatSessionId: chatB,
    });
    expect(fromB.ok).toBe(true);
    if (!fromB.ok) return;
    const chats = (fromB.value as { chats: { chatSessionId: string; pendingCount: number }[] })
      .chats;
    const a = chats.find((c) => c.chatSessionId === chatA);
    expect(a).toBeDefined();
    expect((a?.pendingCount ?? 0) > 0).toBe(true);
    // chat-B has no edits → must not appear at all (its pendingCount is 0).
    expect(chats.find((c) => c.chatSessionId === chatB)).toBeUndefined();

    // Querying with chat-A excluded should NOT return chat-A.
    const fromA = await execute(registry, adapter, humanCtx, "chat.list_open_with_pending", {
      excludeChatSessionId: chatA,
    });
    expect(fromA.ok).toBe(true);
    if (!fromA.ok) return;
    const fromAChats = (fromA.value as { chats: { chatSessionId: string; pendingCount: number }[] })
      .chats;
    expect(fromAChats.find((c) => c.chatSessionId === chatA)).toBeUndefined();
  }, 30_000); // 30s — the cross-chat scan does 6 correlated subqueries per
  //         open chat row, which can be slow on a populated test DB.
});
