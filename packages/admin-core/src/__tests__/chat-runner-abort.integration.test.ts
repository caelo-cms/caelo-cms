// SPDX-License-Identifier: MPL-2.0

/**
 * P5.2 #2 — abortSignal halts the chat-runner loop. The in-flight
 * assistant message gets status='interrupted', tool dispatch stops, and
 * subsequent loop iterations don't run.
 *
 * Uses a slow provider that yields one token, awaits a tick, yields
 * another. The test aborts after the first yield so the runner sees the
 * abort mid-stream.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p5-2-abort",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "p5-2-abort-ai",
};

class SlowProvider extends FixtureProvider {
  readonly #onFirstYield: () => void;
  constructor(onFirstYield: () => void) {
    super([], "claude-test-1");
    this.#onFirstYield = onFirstYield;
  }
  // issue #442 — scripted at the raw model-stream level so the REAL SDK
  // loop handles the mid-stream abort (the SDK cuts the stream and emits
  // its `abort` part; the chat-runner persists the partial interrupted step).
  protected override nextStepStream(options: {
    abortSignal?: AbortSignal;
  }): ReadableStream<unknown> | null {
    const onFirstYield = this.#onFirstYield;
    return new ReadableStream<unknown>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "first" });
        onFirstYield();
        await new Promise((r) => setTimeout(r, 30));
        if (options.abortSignal?.aborted) {
          controller.close();
          return;
        }
        controller.enqueue({ type: "text-delta", id: "t", delta: " second" });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
        });
        controller.close();
      },
    });
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-abort-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-abort-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'p5-2-abort-%'`;
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

describe("chat-runner abort handling", () => {
  it("marks the assistant message interrupted when the signal aborts mid-stream", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "p5-2-abort-1",
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const controller = new AbortController();
    const provider = new SlowProvider(() => controller.abort());
    const tools = createDefaultToolRegistry();
    const events: { kind: string }[] = [];
    for await (const ev of runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx: AI,
        humanCtx: HUMAN,
        abortSignal: controller.signal,
      },
      { chatSessionId, content: "say something", chips: [] },
    )) {
      events.push({ kind: ev.kind });
    }

    expect(events.find((e) => e.kind === "interrupted")).toBeDefined();

    // The assistant row should be persisted with status='interrupted'.
    const sql = new SQL(ADMIN_URL!);
    let interruptedCount = 0;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT count(*)::int AS c FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid
            AND role = 'assistant'
            AND status = 'interrupted'
        `) as unknown as { c: number }[];
        interruptedCount = rows[0]?.c ?? 0;
      });
    } finally {
      await sql.end();
    }
    expect(interruptedCount).toBe(1);
  });
});
