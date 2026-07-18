// SPDX-License-Identifier: MPL-2.0

/**
 * Plan B, Slice 1 — SDK approval gate, chat-runner handling.
 *
 * When the provider stream surfaces a `tool-approval-request` (a gated tool
 * the SDK paused before executing), the runner:
 *   1. yields a `tool-approval-request` ClientEvent (with a preview) so the UI
 *      can render an Approve/Reject card;
 *   2. in autonomous/e2e mode (CAELO_E2E_AUTO_APPROVE_PROPOSALS=1) auto-grants:
 *      appends the SDK tool-approval-response (verbatim ModelMessage) and
 *      CONTINUES the loop, so the next provider call resumes the paused turn;
 *   3. in production mode pauses the turn (stopReason awaiting_approval) for
 *      the Owner's in-chat decision.
 *
 * The fixture provider bypasses the real SDK, so this exercises the runner's
 * pause/auto-resume control flow + the response injection — the real SDK
 * execute + layouts.update mutation is covered by the live e2e suite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import type {
  AIProvider,
  ChatMessageInput,
  GenerateInput,
  GenerateObjectInput,
  GenerateObjectResult,
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
  requestId: "approval-test",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "approval-test-ai",
};

/**
 * Loop 0: model calls the gated tool → SDK pauses → a tool-approval-request
 *   rides the stream (plus the plain tool-call the SDK emits alongside it).
 * Loop 1 (resume): the continuation after the approval — final text.
 */
class ApprovalProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  readonly seenInputs: ReadonlyArray<ChatMessageInput>[] = [];
  #loop = 0;
  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    (this.seenInputs as ChatMessageInput[][]).push([...input.messages]);
    if (this.#loop === 0) {
      this.#loop++;
      yield { kind: "text-delta", text: "I'll update the layout." };
      yield { kind: "tool-call", id: "c1", name: "update_layout", arguments: { layoutId: "x" } };
      yield {
        kind: "tool-approval-request",
        approvalId: "ap-1",
        toolCallId: "c1",
        name: "update_layout",
        arguments: { layoutId: "x" },
      };
      yield { kind: "usage", inputTokens: 5, outputTokens: 4, cachedTokens: 0 };
      yield { kind: "done", stopReason: "tool_use" };
    } else {
      yield { kind: "text-delta", text: "Done — layout updated." };
      yield { kind: "usage", inputTokens: 3, outputTokens: 2, cachedTokens: 0 };
      yield { kind: "done", stopReason: "end_turn" };
    }
  }
  async generateObject(_input: GenerateObjectInput): Promise<GenerateObjectResult> {
    throw new Error("not used");
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'approval-test-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'approval-test-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'approval-test-%'`;
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

afterEach(() => {
  process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = undefined;
});

describe("chat-runner SDK approval gate (Plan B, Slice 1)", () => {
  it("auto-approves + resumes when CAELO_E2E_AUTO_APPROVE_PROPOSALS=1", async () => {
    process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = "1";
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "approval-test-auto",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const provider = new ApprovalProvider();
    const events: { kind: string; preview?: string; name?: string }[] = [];
    for await (const ev of runChatTurn(
      { adapter, registry, provider, tools: new ToolRegistry(), aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "make the header sticky", chips: [] },
    )) {
      events.push({
        kind: ev.kind,
        preview: (ev as { preview?: string }).preview,
        name: (ev as { name?: string }).name,
      });
    }

    // 1. The approval request surfaced to the client with a preview.
    const approval = events.find((e) => e.kind === "tool-approval-request");
    expect(approval).toBeTruthy();
    expect(approval?.name).toBe("update_layout");
    expect(approval?.preview).toContain("layout");

    // 2. Auto-resume: the provider was called TWICE and the SECOND call's
    //    messages carry the tool-approval-response we injected.
    expect(provider.seenInputs.length).toBe(2);
    const resumeMsgs = provider.seenInputs[1] ?? [];
    const approvalResponseMsg = resumeMsgs.find(
      (m) =>
        Array.isArray((m as { sdkMessages?: unknown[] }).sdkMessages) &&
        JSON.stringify((m as { sdkMessages?: unknown[] }).sdkMessages).includes(
          "tool-approval-response",
        ),
    );
    expect(approvalResponseMsg).toBeTruthy();

    // 3. The turn completed cleanly (the continuation text streamed).
    expect(events.some((e) => e.kind === "done")).toBe(true);
  });

  it("pauses (no resume) when the auto-approve flag is off", async () => {
    process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = undefined;
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "approval-test-pause",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const provider = new ApprovalProvider();
    const events: { kind: string }[] = [];
    for await (const ev of runChatTurn(
      { adapter, registry, provider, tools: new ToolRegistry(), aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "make the header sticky", chips: [] },
    )) {
      events.push({ kind: ev.kind });
    }

    // The approval surfaced, but the turn paused — the provider was called
    // exactly ONCE (no resume), matching the awaiting-approval stop.
    expect(events.find((e) => e.kind === "tool-approval-request")).toBeTruthy();
    expect(provider.seenInputs.length).toBe(1);
  });

  it("production resume: input.resumeApproval persists the response row, no user message", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "approval-test-resume",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    // A resume turn carries NO content — just the Owner's decision. The
    // provider only needs to produce the continuation text.
    class ResumeProvider implements AIProvider {
      readonly name: ProviderName = "anthropic";
      readonly model = "claude-test-1";
      async *generate(): AsyncIterable<ProviderEvent> {
        yield { kind: "text-delta", text: "Applied." };
        yield { kind: "usage", inputTokens: 2, outputTokens: 1, cachedTokens: 0 };
        yield { kind: "done", stopReason: "end_turn" };
      }
      async generateObject(): Promise<GenerateObjectResult> {
        throw new Error("not used");
      }
    }

    for await (const _ev of runChatTurn(
      {
        adapter,
        registry,
        provider: new ResumeProvider(),
        tools: new ToolRegistry(),
        aiCtx: AI,
        humanCtx: HUMAN,
      },
      { chatSessionId, chips: [], resumeApproval: { approvalId: "ap-1", approved: true } },
    )) {
      /* drain */
    }

    const sql = new SQL(ADMIN_URL!);
    let rows: { role: string; content: string; response_messages: unknown }[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        rows = (await tx`
          SELECT role, content, response_messages FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid
          ORDER BY created_at ASC
        `) as unknown as { role: string; content: string; response_messages: unknown }[];
      });
    } finally {
      await sql.end();
    }
    // No operator/user row for a resume turn.
    expect(rows.some((r) => r.role === "user")).toBe(false);
    // The approval-response tool row was persisted with the SDK ModelMessage
    // in response_messages (replayed verbatim to resume the paused turn).
    const toolRow = rows.find((r) => r.role === "tool");
    expect(toolRow).toBeTruthy();
    expect(JSON.stringify(toolRow?.response_messages)).toContain("tool-approval-response");
    // The continuation was persisted.
    expect(rows.some((r) => r.role === "assistant" && r.content.includes("Applied"))).toBe(true);
  });
});
