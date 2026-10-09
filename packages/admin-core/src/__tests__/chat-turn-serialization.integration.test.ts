// SPDX-License-Identifier: MPL-2.0

/**
 * PR #624 real-AI run — two turns of one chat must never interleave.
 *
 * The homepage chat's second quality fix-round message was sent while the
 * running turn's `stage_changes` call was still executing. It was persisted
 * BETWEEN that tool call and its result, the provider rejected the history
 * ("tool_use ids were found without tool_result blocks"), and since the
 * rows are persisted every later turn of the chat failed the same way.
 *
 * Here turn A's tool blocks until released while turn B (an auto-sent
 * message) starts: B must not persist or call the provider before A ended,
 * and the history must read A's tool call → A's result → A's answer → B.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t624-serial",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t624-serial-ai",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** Turn A: call the slow tool, then answer. */
class ToolThenAnswer extends FixtureProvider {
  calls = 0;
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.calls += 1;
    if (this.calls === 1) {
      return [
        { kind: "tool-call", id: "tc-slow", name: "slow_stage", arguments: {} },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [
      { kind: "text-delta", text: "Staged." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

/** Turn B: just answer. Records when the provider was first asked. */
class AnswerOnly extends FixtureProvider {
  firstCallAt: number | null = null;
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.firstCallAt ??= Date.now();
    return [
      { kind: "text-delta", text: "Fixing it." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 't624-serial%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 't624-serial%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 't624-serial%'`;
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

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    // consume
  }
}

describe("chat turns are serialized per chat", () => {
  it("a message sent while a tool of the running turn executes waits for that turn", async () => {
    const created = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "t624-serial",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const { chatSessionId } = created.value as { chatSessionId: string };

    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => {
      releaseTool = r;
    });
    let toolStarted!: () => void;
    const toolRunning = new Promise<void>((r) => {
      toolStarted = r;
    });
    let toolEndedAt = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "slow_stage",
      description: "a tool that takes a while (like stage_changes building staging)",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        toolStarted();
        await toolGate;
        toolEndedAt = Date.now();
        return { ok: true, content: "staged" };
      },
    });

    const turnA = drain(
      runChatTurn(
        { adapter, registry, provider: new ToolThenAnswer(), tools, aiCtx: AI, humanCtx: HUMAN },
        { chatSessionId, content: "Build it and stage it.", chips: [] },
      ),
    );
    await toolRunning;
    const providerB = new AnswerOnly();
    const turnB = drain(
      runChatTurn(
        { adapter, registry, provider: providerB, tools, aiCtx: AI, humanCtx: HUMAN },
        { chatSessionId, content: "Fix round 1 of 2: fix the findings.", chips: [] },
      ),
    );
    await Bun.sleep(200);
    // B neither asked the provider nor persisted its message yet.
    expect(providerB.firstCallAt).toBeNull();
    releaseTool();
    await Promise.all([turnA, turnB]);
    expect(providerB.firstCallAt).not.toBeNull();
    expect(providerB.firstCallAt as number).toBeGreaterThanOrEqual(toolEndedAt);

    const sql = new SQL(ADMIN_URL as string);
    let rows: { role: string; content: string; tool_call_id: string | null }[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        rows = (await tx`
          SELECT role, content, tool_call_id FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid AND origin IS DISTINCT FROM 'system'
          ORDER BY created_at, id`) as unknown as typeof rows;
      });
    } finally {
      await sql.end();
    }
    const userB = rows.findIndex((r) => r.role === "user" && r.content.startsWith("Fix round"));
    const toolResult = rows.findIndex((r) => r.role === "tool" && r.tool_call_id === "tc-slow");
    const answerA = rows.findIndex((r) => r.role === "assistant" && r.content === "Staged.");
    expect(toolResult).toBeGreaterThan(-1);
    expect(answerA).toBeGreaterThan(toolResult);
    expect(userB).toBeGreaterThan(answerA);
  });
});
