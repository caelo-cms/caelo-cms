// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.52 — Tool dispatch errors must NOT abort the chat-runner turn.
 *
 * Pre-v0.2.52, chat-runner.ts:1203 re-threw rejected tool dispatches:
 *   const settled = await finalDispatch;
 *   if (!settled.ok) throw settled.error;
 * This propagated out of the generator, the SSE handler caught + closed,
 * and tool-result rows for the failing tool (plus any subsequent tools
 * in the AI's batch) were never persisted. The user saw a chat that
 * appeared to stall mid-session with no visible error and a missing
 * AI message after reload.
 *
 * Post-v0.2.52, a thrown handler becomes a normal `{ok: false, content:
 * "tool error: ..."}` result that flows through the standard yield +
 * persist path. The AI sees the failure on the next provider call and
 * decides whether to retry, switch tools, or give up.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import { runChatTurn } from "../ai/chat-runner.js";
import type { AIProvider, GenerateInput, ProviderEvent, ProviderName } from "../ai/provider.js";
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
  requestId: "v0252-tool-err",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "v0252-tool-err-ai",
};

/**
 * Two-loop provider: emits text + a single tool_use on the first loop,
 * then receives the failed tool_result on the next loop and ends the
 * turn with text + end_turn. Mirrors what the real Anthropic provider
 * does when the runner re-prompts after a tool dispatch.
 */
class TwoLoopProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  #loop = 0;
  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    if (this.#loop === 0) {
      this.#loop++;
      yield { kind: "text-delta", text: "trying the throwing tool" };
      yield { kind: "tool-call", id: "tc-1", name: "throwing_tool", arguments: {} };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
      yield { kind: "done", stopReason: "tool_use" };
    } else {
      yield { kind: "text-delta", text: "got it; giving up gracefully" };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
      yield { kind: "done", stopReason: "end_turn" };
    }
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'v0252-tool-err-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'v0252-tool-err-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'v0252-tool-err-%'`;
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

describe("chat-runner tool-error recovery (v0.2.52)", () => {
  it("treats a throwing tool handler as a failed tool_result, runs the next provider loop, and persists the tool row", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "v0252-tool-err-1",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const tools = new ToolRegistry();
    tools.register({
      name: "throwing_tool",
      description: "always throws synchronously",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        throw new Error("boom from inside the handler");
      },
    });

    const provider = new TwoLoopProvider();
    const events: { kind: string; ok?: boolean; content?: string }[] = [];
    for await (const ev of runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx: AI,
        humanCtx: HUMAN,
      },
      { chatSessionId, content: "use the throwing tool", chips: [] },
    )) {
      events.push({
        kind: ev.kind,
        ok: (ev as { ok?: boolean }).ok,
        content: (ev as { content?: string }).content,
      });
    }

    // The runner emitted a failed tool_result, NOT an error+early-exit.
    const toolResult = events.find((e) => e.kind === "tool-result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.ok).toBe(false);
    expect(toolResult?.content).toContain("tool error");
    expect(toolResult?.content).toContain("boom from inside the handler");

    // The runner went into the second provider loop after the failed
    // tool — we should see the second-loop text-delta in the stream.
    const textDeltas = events.filter((e) => e.kind === "text-delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(2);

    // The runner reached the post-loop usage + done events; no early
    // SSE close from a thrown exception.
    expect(events.find((e) => e.kind === "usage")).toBeDefined();
    expect(events.find((e) => e.kind === "done")).toBeDefined();

    // Tool-result row persisted to chat_messages with the error content.
    const sql = new SQL(ADMIN_URL!);
    let toolRowCount = 0;
    let toolRowContent = "";
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT content FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid
            AND role = 'tool'
            AND tool_call_id = 'tc-1'
        `) as unknown as { content: string }[];
        toolRowCount = rows.length;
        toolRowContent = rows[0]?.content ?? "";
      });
    } finally {
      await sql.end();
    }
    expect(toolRowCount).toBe(1);
    expect(toolRowContent).toContain("tool error");
    expect(toolRowContent).toContain("boom from inside the handler");
  });
});
