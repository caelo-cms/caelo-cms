// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 — passive-turn recovery in the chat-runner loop.
 *
 * Step-13's browser walk caught the footer path failing because the model
 * narrated the action ("A site-wide footer belongs on the layout's footer
 * block ... adding it there now.") and then ended the turn with ZERO tool
 * calls (loopStop='end_turn'). The operator had to manually type "go ahead"
 * to get `add_module_to_layout` to fire. Per CLAUDE.md §4 that's a real
 * defect in our layer, not model nondeterminism: the runner now nudges once
 * and re-prompts when the assistant announces an action without emitting a
 * tool call.
 *
 * These tests pin BOTH directions against a real Postgres + the runner:
 *  1. announced-action-without-tool → one nudge → the tool fires on retry.
 *  2. clarifying-question-without-tool → NO retry (the v0.5.9 false-positive
 *     class must not come back).
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
  requestId: "issue106-passive",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue106-passive-ai",
};

/**
 * Loop 0: announce an action + end_turn with NO tool call (the passive
 * failure). Loop 1 (only reached if the runner re-prompts after the nudge):
 * emit the tool call. Loop 2: end. `calls` records how many times
 * generate() ran so the control test can assert "no retry".
 */
class AnnouncedThenToolProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  calls = 0;
  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    const loop = this.calls;
    this.calls += 1;
    if (loop === 0) {
      yield { kind: "text-delta", text: "Adding the footer to the layout now." };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
      yield { kind: "done", stopReason: "end_turn" };
    } else if (loop === 1) {
      yield { kind: "tool-call", id: "tc-footer", name: "record_footer", arguments: {} };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
      yield { kind: "done", stopReason: "tool_use" };
    } else {
      yield { kind: "text-delta", text: "Footer added." };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
      yield { kind: "done", stopReason: "end_turn" };
    }
  }
}

/** Loop 0: a clarifying QUESTION + end_turn, no tool. Must NOT be retried. */
class ClarifyingQuestionProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  calls = 0;
  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    yield { kind: "text-delta", text: "Want me to add a footer with Home, About, and Contact links?" };
    yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'issue106-passive-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'issue106-passive-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'issue106-passive-%'`;
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

describe("chat-runner passive-turn recovery (issue #106)", () => {
  it("nudges once and the announced tool call fires on the retry", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "issue106-passive-announced",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    let toolRan = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "record_footer",
      description: "records that the footer add fired",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        toolRan += 1;
        return { ok: true, content: "footer recorded" };
      },
    });

    // Neutral user content — keyword-matching skills can engage an
    // allowlist that filters out this test's synthetic tool, which would
    // make filteredTools empty and mask the behaviour under test. The
    // detector keys on the ASSISTANT text (from the provider), not this.
    const provider = new AnnouncedThenToolProvider();
    const events: { kind: string; ok?: boolean }[] = [];
    for await (const ev of runChatTurn(
      { adapter, registry, provider, tools, aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "Please proceed.", chips: [] },
    )) {
      events.push({ kind: ev.kind, ok: (ev as { ok?: boolean }).ok });
    }

    // The nudge re-prompted: generate ran 3× (passive → nudge retry → post-tool).
    expect(provider.calls).toBe(3);
    // The announced tool actually fired.
    expect(toolRan).toBe(1);
    const toolResult = events.find((e) => e.kind === "tool-result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.ok).toBe(true);

    // The synthetic nudge is in-memory only — it must NOT be persisted as a
    // visible user turn in chat history.
    const sql = new SQL(ADMIN_URL!);
    let userMsgs: string[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT content FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid AND role = 'user'
          ORDER BY created_at ASC
        `) as unknown as { content: string }[];
        userMsgs = rows.map((r) => r.content);
      });
    } finally {
      await sql.end();
    }
    expect(userMsgs).toEqual(["Please proceed."]);
  });

  it("does NOT retry a clarifying question (no v0.5.9 false-positive)", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "issue106-passive-question",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    let toolRan = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "record_footer",
      description: "records that the footer add fired",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        toolRan += 1;
        return { ok: true, content: "footer recorded" };
      },
    });

    const provider = new ClarifyingQuestionProvider();
    for await (const _ev of runChatTurn(
      { adapter, registry, provider, tools, aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "Please proceed.", chips: [] },
    )) {
      // drain
    }

    // No nudge: a clarifying question is a legitimate text-only turn.
    expect(provider.calls).toBe(1);
    expect(toolRan).toBe(0);
  });
});
