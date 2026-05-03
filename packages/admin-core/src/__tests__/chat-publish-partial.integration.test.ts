// SPDX-License-Identifier: MPL-2.0

/**
 * P5.2 #5 — partial publish. The chat-runner edits two modules in one
 * branch; the editor publishes only the first; the second stays on the
 * branch. published_at is NULL until the second publish call lands.
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

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p5-2-partial",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "p5-2-partial-ai",
};

const SLUG_A = "p5-2-partial-mod-a";
const SLUG_B = "p5-2-partial-mod-b";

class TwoTurnProvider extends FixtureProvider {
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

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-partial-%')`;
      await tx`DELETE FROM chat_tool_results WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-partial-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-partial-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'p5-2-partial-%'`;
      await tx`DELETE FROM modules WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
    });
  } finally {
    await sql.end();
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

describe("chat.publish partial", () => {
  it("publishes only the listed entity; session stays open for the rest", async () => {
    const ca = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: SLUG_A,
      displayName: "A",
      html: "<p>a-v0</p>",
    });
    const cb = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: SLUG_B,
      displayName: "B",
      html: "<p>b-v0</p>",
    });
    if (!ca.ok || !cb.ok) throw new Error("seed");
    const modA = (ca.value as { moduleId: string }).moduleId;
    const modB = (cb.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "p5-2-partial-1",
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const provider = new TwoTurnProvider([
      [
        {
          kind: "tool-call",
          id: "ta",
          name: "edit_module",
          arguments: { moduleId: modA, html: "<p>a-v1</p>" },
        },
        {
          kind: "tool-call",
          id: "tb",
          name: "edit_module",
          arguments: { moduleId: modB, html: "<p>b-v1</p>" },
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
    const tools = createDefaultToolRegistry();
    for await (const _ of runChatTurn(
      { adapter, registry, provider, tools, aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "edit both", chips: [] },
    )) {
      // drain
    }

    // Partial publish: only module A.
    const partial = await execute(registry, adapter, HUMAN, "chat.publish", {
      chatSessionId,
      entities: [{ kind: "module", entityId: modA }],
    });
    if (!partial.ok) {
      throw new Error(`partial publish failed: ${JSON.stringify(partial.error)}`);
    }
    expect((partial.value as { entityCount: number }).entityCount).toBe(1);

    // Session is still open — published_at must remain NULL.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT published_at FROM chat_sessions WHERE id = ${chatSessionId}::uuid
        `) as unknown as { published_at: string | null }[];
        expect(rows[0]?.published_at).toBeNull();
      });
    } finally {
      await sql.end();
    }

    // Now publish the rest (no filter → publish everything still on the
    // branch, which is just module B).
    const second = await execute(registry, adapter, HUMAN, "chat.publish", {
      chatSessionId,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((second.value as { entityCount: number }).entityCount).toBe(1);
  });
});
