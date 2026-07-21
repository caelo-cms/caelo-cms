// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.54 — Extended-thinking round-trip.
 *
 * When a chat session has `extended_thinking_enabled = true`:
 *   1. The runner threads `thinking: { budgetTokens }` to provider.generate.
 *   2. The provider's `thinking-delta` events flow through to the client
 *      as `thinking-delta` ClientEvents.
 *   3. `thinking-stop` events accumulate; the assistant's `chat_messages`
 *      row gets `thinking_blocks` populated for round-tripping.
 *   4. On the next provider loop (after tool dispatch), the prior turn's
 *      thinking blocks appear in `messages` so Anthropic can verify the
 *      cryptographic signatures.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import { runChatTurn } from "../ai/chat-runner.js";
import type {
  AIProvider,
  ChatMessageInput,
  GenerateInput,
  ProviderEvent,
  ProviderName,
} from "../ai/provider.js";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "v0254-think",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "v0254-think-ai",
};

/**
 * Records every `messages` array it receives so the test can assert
 * that the second-loop call carries the first loop's thinking blocks.
 *
 * Loop 1: emits one thinking block + text + a tool_use + done(tool_use).
 * Loop 2: emits text + done(end_turn) — but only after the runner has
 *         dispatched the tool and re-prompted us.
 */
class ThinkingProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  readonly seenInputs: ReadonlyArray<ChatMessageInput>[] = [];
  #loop = 0;
  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    (this.seenInputs as ChatMessageInput[][]).push([...input.messages]);
    if (this.#loop === 0) {
      this.#loop++;
      yield { kind: "thinking-delta", text: "let me think… " };
      yield { kind: "thinking-delta", text: "yes, I should call the tool." };
      yield {
        kind: "thinking-stop",
        thinking: "let me think… yes, I should call the tool.",
        signature: "sig-loop1-abc",
      };
      yield { kind: "text-delta", text: "Trying the tool now." };
      yield { kind: "tool-call", id: "tc-1", name: "noop_tool", arguments: {} };
      yield { kind: "usage", inputTokens: 5, outputTokens: 10, cachedTokens: 0 };
      yield { kind: "done", stopReason: "tool_use" };
    } else {
      yield { kind: "text-delta", text: "Done." };
      yield { kind: "usage", inputTokens: 3, outputTokens: 1, cachedTokens: 0 };
      yield { kind: "done", stopReason: "end_turn" };
    }
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'v0254-think-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'v0254-think-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'v0254-think-%'`;
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

describe("chat-runner extended thinking (v0.2.54)", () => {
  it("streams thinking-delta, persists thinking_blocks, and round-trips them on the next loop", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "v0254-think-1",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    // Enable extended thinking on the session BEFORE the first turn.
    const toggle = await execute(registry, adapter, HUMAN, "chat.set_extended_thinking", {
      chatSessionId,
      enabled: true,
      budgetTokens: 2048,
    });
    if (!toggle.ok) throw new Error("toggle failed");

    const tools = new ToolRegistry();
    tools.register({
      name: "noop_tool",
      description: "no-op",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ ok: true, content: "noop done" }),
    });

    const provider = new ThinkingProvider();
    const events: { kind: string; text?: string; thinking?: string }[] = [];
    for await (const ev of runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx: AI,
        humanCtx: HUMAN,
      },
      { chatSessionId, content: "do the thing", chips: [] },
    )) {
      events.push({
        kind: ev.kind,
        text: (ev as { text?: string }).text,
        thinking: (ev as { thinking?: string }).thinking,
      });
    }

    // 1. thinking-delta events flowed through to the client.
    const thinkingDeltas = events.filter((e) => e.kind === "thinking-delta");
    expect(thinkingDeltas.length).toBe(2);
    expect(thinkingDeltas[0]?.text).toBe("let me think… ");
    expect(thinkingDeltas[1]?.text).toBe("yes, I should call the tool.");

    // 2. thinking-stop event includes the full block + signature.
    const thinkingStops = events.filter((e) => e.kind === "thinking-stop");
    expect(thinkingStops.length).toBe(1);
    expect(thinkingStops[0]?.thinking).toContain("let me think");

    // 3. The provider's SECOND call (loop 2) received the prior turn's
    //    thinking blocks in its messages array. The first call has only
    //    the user message; the second call has user + assistant
    //    (with thinkingBlocks) + tool_result.
    expect(provider.seenInputs.length).toBe(2);
    const loop2Messages = provider.seenInputs[1];
    expect(loop2Messages).toBeDefined();
    const assistant = loop2Messages?.find((m) => m.role === "assistant");
    expect(assistant?.thinkingBlocks).toBeDefined();
    expect(assistant?.thinkingBlocks?.[0]?.signature).toBe("sig-loop1-abc");

    // 4. chat_messages.thinking_blocks is populated for the assistant
    //    turn that carried the thinking. (Stored as JSON; read back as
    //    array.)
    const sql = new SQL(ADMIN_URL!);
    let thinkingBlocksRaw: unknown = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT thinking_blocks FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid
            AND role = 'assistant'
            AND thinking_blocks IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 1
        `) as unknown as { thinking_blocks: unknown }[];
        thinkingBlocksRaw = rows[0]?.thinking_blocks ?? null;
      });
    } finally {
      await sql.end();
    }
    const thinkingBlocks =
      typeof thinkingBlocksRaw === "string"
        ? (JSON.parse(thinkingBlocksRaw) as { thinking: string; signature: string }[])
        : (thinkingBlocksRaw as { thinking: string; signature: string }[]);
    expect(Array.isArray(thinkingBlocks)).toBe(true);
    expect(thinkingBlocks?.[0]?.signature).toBe("sig-loop1-abc");
    expect(thinkingBlocks?.[0]?.thinking).toContain("let me think");
  });

  it("does NOT pass thinking when the session toggle is off", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "v0254-think-2",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };
    // Extended thinking now defaults ON for main chats (migration 0171 —
    // "thinking on by default for main chats, off for subagents"), so a fresh
    // session inherits enabled=true. Turn it OFF explicitly to exercise the
    // toggle-off path this test asserts (no `thinking` on the provider input).
    const off = await execute(registry, adapter, HUMAN, "chat.set_extended_thinking", {
      chatSessionId,
      enabled: false,
    });
    if (!off.ok) throw new Error("toggle-off failed");

    const tools = new ToolRegistry();
    /**
     * Records whether the runner passed `thinking` on its provider input.
     * If the session toggle is off, `input.thinking` MUST be undefined.
     */
    let observedThinking: GenerateInput["thinking"] | undefined;
    class NoThinkProvider implements AIProvider {
      readonly name: ProviderName = "anthropic";
      readonly model = "claude-test-1";
      async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
        observedThinking = input.thinking;
        yield { kind: "text-delta", text: "ok" };
        yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
        yield { kind: "done", stopReason: "end_turn" };
      }
    }

    for await (const _ev of runChatTurn(
      {
        adapter,
        registry,
        provider: new NoThinkProvider(),
        tools,
        aiCtx: AI,
        humanCtx: HUMAN,
      },
      { chatSessionId, content: "hi", chips: [] },
    )) {
      // drain
    }
    expect(observedThinking).toBeUndefined();
  });
});
