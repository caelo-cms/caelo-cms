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
import { z } from "zod";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ChatMessageInput, GenerateInput, ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
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
 * Run 1, step 0: the model calls the gated tool → the REAL SDK toolApproval
 *   machinery pauses it and emits the tool-approval-request (issue #442 —
 *   the request is no longer a scriptable provider event).
 * Run 2 (resume): the continuation after the approval — final text.
 */
class ApprovalProvider extends FixtureProvider {
  readonly seenInputs: ReadonlyArray<ChatMessageInput>[] = [];
  #loop = 0;
  constructor() {
    super([], "claude-test-1");
  }
  override async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    (this.seenInputs as ChatMessageInput[][]).push([...input.messages]);
    yield* super.generate(input);
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    if (this.#loop === 0) {
      this.#loop++;
      return [
        { kind: "text-delta", text: "I'll update the layout." },
        { kind: "tool-call", id: "c1", name: "update_layout", arguments: { layoutId: "x" } },
        { kind: "usage", inputTokens: 5, outputTokens: 4, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [
      { kind: "text-delta", text: "Done — layout updated." },
      { kind: "usage", inputTokens: 3, outputTokens: 2, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

/** A gated `update_layout` catalogue entry: the chat-runner attaches the SDK
 *  approvalMode + execute from the `gated` marker (the propose/execute ops
 *  are absent from this fixture registry — the chained apply fails, which is
 *  irrelevant to the pause/resume orchestration under test). */
function gatedToolRegistry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "update_layout",
    description: "update the site layout",
    schema: z.object({ layoutId: z.string() }),
    inputSchema: { type: "object", properties: { layoutId: { type: "string" } } },
    gated: { proposeOp: "layouts_test.propose_update", executeOp: "layouts_test.execute_proposal" },
    handler: async () => ({ ok: true, content: "unused (SDK-gated)" }),
  });
  return tools;
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
      { adapter, registry, provider, tools: gatedToolRegistry(), aiCtx: AI, humanCtx: HUMAN },
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
      { adapter, registry, provider, tools: gatedToolRegistry(), aiCtx: AI, humanCtx: HUMAN },
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

    // issue #442 — the resume history must carry the COMPLETE paused state:
    // the SDK's collectToolApprovals rejects an approval-response whose
    // request is absent from history (pre-#442 the fabricated response-only
    // history slipped through only because the hand-rolled fixture provider
    // never touched the SDK). Persist the paused assistant turn the way the
    // chat-runner does: the Option-C slice with the gated tool-call + its
    // tool-approval-request part.
    const paused = await execute(registry, adapter, HUMAN, "chat.append_message", {
      chatSessionId,
      role: "assistant",
      content: "I'll update the layout.",
      toolCalls: [{ id: "c1", name: "update_layout", arguments: { layoutId: "x" } }],
      responseMessages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll update the layout." },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "update_layout",
              input: { layoutId: "x" },
            },
            { type: "tool-approval-request", approvalId: "ap-1", toolCallId: "c1" },
          ],
        },
      ],
      status: "complete",
    });
    if (!paused.ok) throw new Error("paused turn seed failed");

    // A resume turn carries NO content — just the Owner's decision. The
    // provider only needs to produce the continuation text. It CAPTURES its
    // input messages so we can assert the SDK-approval invariant below.
    class ResumeProvider extends FixtureProvider {
      readonly seenInputs: ReadonlyArray<ChatMessageInput>[] = [];
      constructor() {
        super(
          [
            { kind: "text-delta", text: "Applied." },
            { kind: "usage", inputTokens: 2, outputTokens: 1, cachedTokens: 0 },
            { kind: "done", stopReason: "end_turn" },
          ],
          "claude-test-1",
        );
      }
      override async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
        (this.seenInputs as ChatMessageInput[][]).push([...input.messages]);
        yield* super.generate(input);
      }
    }

    const resumeProvider = new ResumeProvider();
    for await (const _ev of runChatTurn(
      {
        adapter,
        registry,
        provider: resumeProvider,
        tools: gatedToolRegistry(),
        aiCtx: AI,
        humanCtx: HUMAN,
      },
      { chatSessionId, chips: [], resumeApproval: { approvalId: "ap-1", approved: true } },
    )) {
      /* drain */
    }

    // THE FIX (SDK collectToolApprovals): on a resume, the LAST provider
    // message MUST be the tool-approval-response. The AI SDK only executes an
    // approved gated tool when `messages.at(-1).role === "tool"`; a trailing
    // status/page-context user note (which the runner injects on other turns)
    // would strand the gated tool_use UNEXECUTED → the next call 400s
    // ("tool_use without tool_result"). Assert no trailing note slipped in.
    const resumeInput = resumeProvider.seenInputs[0] ?? [];
    const lastMsg = resumeInput.at(-1);
    expect(lastMsg?.role).toBe("tool");
    expect(JSON.stringify((lastMsg as { sdkMessages?: unknown[] }).sdkMessages)).toContain(
      "tool-approval-response",
    );

    const sql = new SQL(ADMIN_URL!);
    let rows: {
      role: string;
      origin: string | null;
      content: string;
      response_messages: unknown;
    }[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        rows = (await tx`
          SELECT role, origin, content, response_messages FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid
          ORDER BY created_at ASC
        `) as unknown as {
          role: string;
          origin: string | null;
          content: string;
          response_messages: unknown;
        }[];
      });
    } finally {
      await sql.end();
    }
    // NO user row on a resume turn — neither an operator message nor an
    // injected status/page-context note. The runner skips note injection on a
    // resume so the tool-approval-response stays the LAST message (the SDK's
    // collectToolApprovals requirement); a trailing note stranded the gated
    // tool_use and 400'd the next call.
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
