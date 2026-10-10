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
 *
 * Issue #628 — the same must hold when A and B run on two admin instances
 * (separate serializers, separate connection pools, one database), an
 * aborted or crashed turn must free the chat, and a chat whose history an
 * earlier interleaving already wedged must load and continue.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import { ChatTurnSerializer } from "../ai/chat-runner/turn-serializer.js";
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
/** A second connection pool: the "other admin instance". */
let adapterB: DatabaseAdapter;
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
  adapterB = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
  await adapterB.close();
});

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const ev of it) events.push(ev);
  return events;
}

/** Fast-polling serializer: tests should not sit out production intervals. */
function fastSerializer(leaseTtlMs = 60_000): ChatTurnSerializer {
  return new ChatTurnSerializer({
    leaseTtlMs,
    waitTimeoutMs: 30_000,
    pollMinMs: 20,
    pollMaxMs: 50,
  });
}

async function createChat(title: string): Promise<string> {
  const created = await execute(registry, adapter, HUMAN, "chat.create_session", { title });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return (created.value as { chatSessionId: string }).chatSessionId;
}

async function readRows(
  chatSessionId: string,
): Promise<{ role: string; content: string; tool_call_id: string | null }[]> {
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
  return rows;
}

async function leaseRows(chatSessionId: string): Promise<{ holder_id: string }[]> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        SELECT holder_id FROM chat_turn_leases WHERE chat_session_id = ${chatSessionId}::uuid
      `) as unknown as { holder_id: string }[];
    });
  } finally {
    await sql.end();
  }
}

/** The slow_stage tool, gated so the test decides when it finishes. */
function gatedStageTool(): {
  tools: ToolRegistry;
  running: Promise<void>;
  finish: () => void;
  endedAt: () => number;
} {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  let started!: () => void;
  const running = new Promise<void>((r) => {
    started = r;
  });
  let endedAt = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "slow_stage",
    description: "a tool that takes a while (like stage_changes building staging)",
    schema: z.object({}),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      started();
      await gate;
      endedAt = Date.now();
      return { ok: true, content: "staged" };
    },
  });
  return { tools, running, finish, endedAt: () => endedAt };
}

/**
 * Turn A calls the slow tool; while it runs, turn B (an auto-sent fix
 * round) starts. B must neither persist nor ask the provider before A ended,
 * and the history must read A's call → A's result → A's answer → B.
 */
async function assertTurnsDoNotInterleave(instances: {
  a: { adapter: DatabaseAdapter; turnSerializer?: ChatTurnSerializer };
  b: { adapter: DatabaseAdapter; turnSerializer?: ChatTurnSerializer };
}): Promise<void> {
  const chatSessionId = await createChat("t624-serial");
  const stage = gatedStageTool();
  const turnA = drain(
    runChatTurn(
      {
        ...instances.a,
        registry,
        provider: new ToolThenAnswer(),
        tools: stage.tools,
        aiCtx: AI,
        humanCtx: HUMAN,
      },
      { chatSessionId, content: "Build it and stage it.", chips: [] },
    ),
  );
  await stage.running;
  const providerB = new AnswerOnly();
  const turnB = drain(
    runChatTurn(
      {
        ...instances.b,
        registry,
        provider: providerB,
        tools: stage.tools,
        aiCtx: AI,
        humanCtx: HUMAN,
      },
      { chatSessionId, content: "Fix round 1 of 2: fix the findings.", chips: [] },
    ),
  );
  await Bun.sleep(300);
  // B neither asked the provider nor persisted its message yet.
  expect(providerB.firstCallAt).toBeNull();
  expect((await readRows(chatSessionId)).some((r) => r.content.startsWith("Fix round"))).toBe(
    false,
  );
  stage.finish();
  await Promise.all([turnA, turnB]);
  expect(providerB.firstCallAt).not.toBeNull();
  expect(providerB.firstCallAt as number).toBeGreaterThanOrEqual(stage.endedAt());

  const rows = await readRows(chatSessionId);
  const call = rows.findIndex((r) => r.role === "assistant" && r.content === "");
  const toolResult = rows.findIndex((r) => r.role === "tool" && r.tool_call_id === "tc-slow");
  const answerA = rows.findIndex((r) => r.role === "assistant" && r.content === "Staged.");
  const userB = rows.findIndex((r) => r.role === "user" && r.content.startsWith("Fix round"));
  const answerB = rows.findIndex((r) => r.role === "assistant" && r.content === "Fixing it.");
  expect(call).toBeGreaterThan(-1);
  expect(toolResult).toBe(call + 1);
  expect(answerA).toBe(toolResult + 1);
  expect(userB).toBe(answerA + 1);
  expect(answerB).toBe(userB + 1);
  // Both turns let go of the chat.
  expect(await leaseRows(chatSessionId)).toEqual([]);
}

describe("chat turns are serialized per chat", () => {
  it("a message sent while a tool of the running turn executes waits for that turn", async () => {
    await assertTurnsDoNotInterleave({ a: { adapter }, b: { adapter } });
  });

  it("issue #628: also across two admin instances (own serializer + own connection pool each)", async () => {
    await assertTurnsDoNotInterleave({
      a: { adapter, turnSerializer: fastSerializer() },
      b: { adapter: adapterB, turnSerializer: fastSerializer() },
    });
  });

  it("issue #628: an aborted turn releases the chat at once", async () => {
    const chatSessionId = await createChat("t624-serial-abort");
    const stage = gatedStageTool();
    const ctl = new AbortController();
    const turnA = drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider: new ToolThenAnswer(),
          tools: stage.tools,
          aiCtx: AI,
          humanCtx: HUMAN,
          abortSignal: ctl.signal,
          turnSerializer: fastSerializer(),
        },
        { chatSessionId, content: "Build it and stage it.", chips: [] },
      ),
    );
    await stage.running;
    expect((await leaseRows(chatSessionId)).length).toBe(1);
    ctl.abort();
    stage.finish();
    await turnA;
    expect(await leaseRows(chatSessionId)).toEqual([]);

    // The next turn, on another instance, starts without waiting out the
    // 60 s lease TTL.
    const startedAt = Date.now();
    const providerB = new AnswerOnly();
    await drain(
      runChatTurn(
        {
          adapter: adapterB,
          registry,
          provider: providerB,
          tools: stage.tools,
          aiCtx: AI,
          humanCtx: HUMAN,
          turnSerializer: fastSerializer(),
        },
        { chatSessionId, content: "Go on.", chips: [] },
      ),
    );
    expect(providerB.firstCallAt).not.toBeNull();
    expect((providerB.firstCallAt as number) - startedAt).toBeLessThan(10_000);
  });

  it("issue #628: a crashed instance's lease lapses and the next turn takes over", async () => {
    const chatSessionId = await createChat("t624-serial-crash");
    // The crashed instance claimed the chat and then never renewed or
    // released it.
    const claimed = await execute(registry, adapterB, HUMAN, "chat.acquire_turn_lease", {
      chatSessionId,
      holderId: "crashed-instance",
      ttlMs: 1_500,
    });
    expect(claimed.ok && (claimed.value as { acquired: boolean }).acquired).toBe(true);

    const startedAt = Date.now();
    const provider = new AnswerOnly();
    const events = await drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider,
          tools: new ToolRegistry(),
          aiCtx: AI,
          humanCtx: HUMAN,
          turnSerializer: fastSerializer(),
        },
        { chatSessionId, content: "Are you there?", chips: [] },
      ),
    );
    expect(events.some((e) => (e as { kind: string }).kind === "error")).toBe(false);
    expect(provider.firstCallAt).not.toBeNull();
    expect((provider.firstCallAt as number) - startedAt).toBeGreaterThanOrEqual(1_000);
    expect(await leaseRows(chatSessionId)).toEqual([]);
  });

  it("issue #628: a turn that waits past the bound persists nothing and says what to do", async () => {
    const chatSessionId = await createChat("t624-serial-busy");
    const claimed = await execute(registry, adapterB, HUMAN, "chat.acquire_turn_lease", {
      chatSessionId,
      holderId: "long-running-turn",
      ttlMs: 60_000,
    });
    expect(claimed.ok).toBe(true);
    const provider = new AnswerOnly();
    const events = await drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider,
          tools: new ToolRegistry(),
          aiCtx: AI,
          humanCtx: HUMAN,
          turnSerializer: new ChatTurnSerializer({ waitTimeoutMs: 300, pollMinMs: 20 }),
        },
        { chatSessionId, content: "Hello?", chips: [] },
      ),
    );
    const error = events.find((e) => (e as { kind: string }).kind === "error") as
      | { message: string }
      | undefined;
    expect(error?.message).toContain("still answering an earlier message");
    expect(provider.firstCallAt).toBeNull();
    expect(await readRows(chatSessionId)).toEqual([]);
    // The running turn's lease is untouched.
    expect(await leaseRows(chatSessionId)).toEqual([{ holder_id: "long-running-turn" }]);
  });
});

describe("issue #628: a chat wedged by an earlier interleaving loads and continues", () => {
  it("replays the separated result next to its call and answers the next message", async () => {
    const chatSessionId = await createChat("t624-serial-wedged");
    // The persisted PR #624 shape: A's call, B's fix-round message and
    // answer, THEN A's result and answer.
    const append = async (row: Record<string, unknown>): Promise<void> => {
      const r = await execute(registry, adapter, HUMAN, "chat.append_message", {
        chatSessionId,
        status: "complete",
        ...row,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    };
    await append({ role: "user", content: "Build it and stage it." });
    await append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc-wedged", name: "slow_stage", arguments: {} }],
      responseMessages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc-wedged", toolName: "slow_stage", input: {} },
          ],
        },
      ],
    });
    await append({ role: "user", content: "Fix round 1 of 2: fix the findings." });
    await append({ role: "assistant", content: "Fixing it." });
    await append({ role: "tool", content: "staged", toolCallId: "tc-wedged" });
    await append({ role: "assistant", content: "Staged." });

    const provider = new AnswerOnly();
    const events = await drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider,
          tools: new ToolRegistry(),
          aiCtx: AI,
          humanCtx: HUMAN,
          turnSerializer: fastSerializer(),
        },
        { chatSessionId, content: "Is it live?", chips: [] },
      ),
    );
    expect(events.some((e) => (e as { kind: string }).kind === "error")).toBe(false);

    // What the model saw: the call's result directly after the call.
    const prompt = provider.seenPrompts[0] as {
      role: string;
      content: unknown;
    }[];
    expect(prompt).toBeDefined();
    const partsOf = (m: { content: unknown }): { type?: string; toolCallId?: string }[] =>
      Array.isArray(m.content) ? (m.content as { type?: string; toolCallId?: string }[]) : [];
    const callAt = prompt.findIndex((m) =>
      partsOf(m).some((p) => p.type === "tool-call" && p.toolCallId === "tc-wedged"),
    );
    const resultAt = prompt.findIndex((m) =>
      partsOf(m).some((p) => p.type === "tool-result" && p.toolCallId === "tc-wedged"),
    );
    expect(callAt).toBeGreaterThan(-1);
    expect(resultAt).toBe(callAt + 1);

    // And the turn went through: its answer is persisted after the message.
    const rows = await readRows(chatSessionId);
    expect(rows.at(-2)?.content).toBe("Is it live?");
    expect(rows.at(-1)?.content).toBe("Fixing it.");
  });
});

describe("issue #628: chat.*_turn_lease ops", () => {
  it("one holder at a time; only the holder renews or releases; a lapsed lease is taken over", async () => {
    const chatSessionId = await createChat("t624-serial-ops");
    const call = async (op: string, input: Record<string, unknown>): Promise<unknown> => {
      const r = await execute(registry, adapter, HUMAN, op, { chatSessionId, ...input });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };
    expect(await call("chat.acquire_turn_lease", { holderId: "a", ttlMs: 400 })).toMatchObject({
      acquired: true,
      tookOverExpiredHolderId: null,
    });
    const refused = (await call("chat.acquire_turn_lease", { holderId: "b", ttlMs: 400 })) as {
      acquired: boolean;
      heldBy: { holderId: string } | null;
    };
    expect(refused.acquired).toBe(false);
    expect(refused.heldBy?.holderId).toBe("a");
    expect(await call("chat.renew_turn_lease", { holderId: "b", ttlMs: 400 })).toEqual({
      held: false,
    });
    expect(await call("chat.release_turn_lease", { holderId: "b" })).toEqual({ released: false });
    expect(await call("chat.renew_turn_lease", { holderId: "a", ttlMs: 400 })).toEqual({
      held: true,
    });
    await Bun.sleep(600);
    expect(await call("chat.acquire_turn_lease", { holderId: "b", ttlMs: 400 })).toMatchObject({
      acquired: true,
      tookOverExpiredHolderId: "a",
    });
    // The stalled former holder can neither renew nor delete b's lease.
    expect(await call("chat.renew_turn_lease", { holderId: "a", ttlMs: 400 })).toEqual({
      held: false,
    });
    expect(await call("chat.release_turn_lease", { holderId: "a" })).toEqual({ released: false });
    expect(await call("chat.release_turn_lease", { holderId: "b" })).toEqual({ released: true });
    expect(await leaseRows(chatSessionId)).toEqual([]);
  });

  it("refuses a chat that does not exist with a next step", async () => {
    const r = await execute(registry, adapter, HUMAN, "chat.acquire_turn_lease", {
      chatSessionId: "4b0c2a9e-6d1f-4c3a-9e2b-000000000628",
      holderId: "a",
      ttlMs: 1_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("does not exist");
  });
});
