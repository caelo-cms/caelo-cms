// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #664 / #665 — Stop is authoritative, and one agent works in a chat
 * at a time.
 *
 * Regression for 2026-10-12 (searchviu): the operator pressed Stop in the
 * Live Edit chat; the server never saw the browser's fetch abort, so the
 * turn ran on (more `build_page`, `stage_changes`), and the quality fix
 * rounds queued behind it started three more turns. At the same time an
 * external Power-MCP agent wrote to the same chat.
 *
 * Every Stop here goes through a SECOND connection pool and never calls the
 * in-process abort fast path — it stands in for the Stop request landing on
 * another admin instance, which is exactly the case the fetch abort missed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import {
  abortLocalAgentRuns,
  OperatorStoppedError,
  startAgentRun,
} from "../ai/chat-runner/agent-runs.js";
import { ChatTurnSerializer } from "../ai/chat-runner/turn-serializer.js";
import type { ClientEvent } from "../ai/chat-runner.js";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

// Fast cancel polling + a short external-agent window: tests should not sit
// out production intervals. Both are read per call.
process.env.CAELO_AGENT_CANCEL_POLL_MS = "50";
process.env.CAELO_EXTERNAL_AGENT_ACTIVE_MS = "1500";

const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000664",
  actorKind: "human",
  requestId: "t664-owner",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t664-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t664-system",
};

let adapter: DatabaseAdapter;
/** The "other admin instance" — where every Stop lands. */
let adapterB: DatabaseAdapter;
let registry: OperationRegistry;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM mcp_tokens WHERE actor_id = ${OWNER.actorId}::uuid`;
    await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 't664%')`;
    await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 't664%')`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE 't664%'`;
    await tx`DELETE FROM structured_sets WHERE slug LIKE 't664-%'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  adapterB = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${OWNER.actorId}::uuid, 'human', 't664 owner') ON CONFLICT (id) DO NOTHING`;
  });
  await wipe();
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
  await adapterB.close();
});

function fastSerializer(): ChatTurnSerializer {
  return new ChatTurnSerializer({ waitTimeoutMs: 30_000, pollMinMs: 20, pollMaxMs: 50 });
}

async function createChat(title: string): Promise<string> {
  const r = await execute(registry, adapter, OWNER, "chat.create_session", { title });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { chatSessionId: string }).chatSessionId;
}

async function drain(it: AsyncIterable<ClientEvent>): Promise<ClientEvent[]> {
  const events: ClientEvent[] = [];
  for await (const ev of it) events.push(ev);
  return events;
}

async function listRuns(
  chatSessionId: string,
): Promise<{ id: string; kind: string; state: string; cancelRequested: boolean }[]> {
  const r = await execute(registry, adapterB, OWNER, "chat.list_agent_runs", { chatSessionId });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (
    r.value as { runs: { id: string; kind: string; state: string; cancelRequested: boolean }[] }
  ).runs;
}

/** Stop, as it arrives on ANOTHER instance: database only, no local abort. */
async function stopFromOtherInstance(chatSessionId: string, runId?: string) {
  const r = await execute(registry, adapterB, OWNER, "chat.cancel_agents", {
    chatSessionId,
    ...(runId ? { runId } : {}),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as {
    cancelledRunIds: string[];
    stoppedExternalAgents: number;
    chatStopped: boolean;
  };
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

async function userRows(chatSessionId: string): Promise<string[]> {
  return withSql(async (tx) => {
    const rows = (await tx`
      SELECT content FROM chat_messages
      WHERE chat_session_id = ${chatSessionId}::uuid AND role = 'user'
        AND content NOT LIKE '[Site status%'
      ORDER BY created_at
    `) as unknown as { content: string }[];
    return rows.map((r) => r.content);
  });
}

/** A tool the test releases, plus a tool that must never run after Stop. */
function gatedTools(): {
  tools: ToolRegistry;
  running: Promise<void>;
  finish: () => void;
  afterStopCalls: () => number;
} {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  let started!: () => void;
  const running = new Promise<void>((r) => {
    started = r;
  });
  let afterStop = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "slow_build",
    description: "a long write (like build_page)",
    schema: z.object({}),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      started();
      await gate;
      return { ok: true, content: "built" };
    },
  });
  tools.register({
    name: "next_write",
    description: "the write the turn would do next (like stage_changes)",
    schema: z.object({}),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      afterStop += 1;
      return { ok: true, content: "staged" };
    },
  });
  return { tools, running, finish, afterStopCalls: () => afterStop };
}

/** Step 1 calls slow_build, step 2 next_write, step 3 answers. */
class BuildThenStage extends FixtureProvider {
  steps = 0;
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.steps += 1;
    const usage = { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 } as const;
    if (this.steps === 1) {
      return [
        {
          kind: "tool-call",
          id: `tc-build-${crypto.randomUUID()}`,
          name: "slow_build",
          arguments: {},
        },
        usage,
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    if (this.steps === 2) {
      return [
        {
          kind: "tool-call",
          id: `tc-stage-${crypto.randomUUID()}`,
          name: "next_write",
          arguments: {},
        },
        usage,
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [{ kind: "text-delta", text: "Done." }, usage, { kind: "done", stopReason: "end_turn" }];
  }
}

class AnswerOnly extends FixtureProvider {
  calls = 0;
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.calls += 1;
    return [
      { kind: "text-delta", text: "OK." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

function liveEditTurn(args: {
  chatSessionId: string;
  provider: FixtureProvider;
  tools: ToolRegistry;
  content: string;
  operator: boolean;
  serializer: ChatTurnSerializer;
  adapter?: DatabaseAdapter;
}): Promise<ClientEvent[]> {
  return drain(
    runChatTurn(
      {
        adapter: args.adapter ?? adapter,
        registry,
        provider: args.provider,
        tools: args.tools,
        aiCtx: AI,
        humanCtx: OWNER,
        turnSerializer: args.serializer,
        agentRunSource: "live_edit",
        operatorInitiated: args.operator,
      },
      {
        chatSessionId: args.chatSessionId,
        content: args.content,
        chips: [],
        ...(args.operator ? {} : { origin: "system" as const }),
      },
    ),
  );
}

describe("Stop is authoritative (issue #664)", () => {
  it("stops a running turn from another instance: no further step, no further write", async () => {
    const chatSessionId = await createChat("t664 stop mid-turn");
    const t = gatedTools();
    const provider = new BuildThenStage();
    const turn = liveEditTurn({
      chatSessionId,
      provider,
      tools: t.tools,
      content: "Build the pricing page.",
      operator: true,
      serializer: fastSerializer(),
    });
    await t.running;
    const before = await listRuns(chatSessionId);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ kind: "turn", state: "running" });

    const stopped = await stopFromOtherInstance(chatSessionId);
    expect(stopped.chatStopped).toBe(true);
    expect(stopped.cancelledRunIds).toEqual([before[0]?.id as string]);
    // The runner hears the Stop through its heartbeat, before the in-flight
    // tool even returns.
    await Bun.sleep(300);
    t.finish();
    const events = await turn;

    expect(t.afterStopCalls()).toBe(0);
    expect(provider.steps).toBe(1);
    expect(events.some((e) => e.kind === "interrupted")).toBe(true);
    expect(await listRuns(chatSessionId)).toHaveLength(0);
  });

  it("drops the turns queued behind the stopped one before they persist anything", async () => {
    const chatSessionId = await createChat("t664 queued drop");
    const t = gatedTools();
    const serializer = fastSerializer();
    const running = liveEditTurn({
      chatSessionId,
      provider: new BuildThenStage(),
      tools: t.tools,
      content: "Build it.",
      operator: true,
      serializer,
    });
    await t.running;
    const nudgeProvider = new AnswerOnly();
    const queued = liveEditTurn({
      chatSessionId,
      provider: nudgeProvider,
      tools: t.tools,
      content: "Fix round 1 of 2: fix the findings.",
      operator: false,
      serializer,
    });
    await waitFor(async () => (await listRuns(chatSessionId)).length === 2);
    expect((await listRuns(chatSessionId)).map((r) => r.state).sort()).toEqual([
      "queued",
      "running",
    ]);

    await stopFromOtherInstance(chatSessionId);
    const queuedEvents = await queued;
    t.finish();
    await running;

    expect(queuedEvents).toContainEqual(
      expect.objectContaining({ kind: "warning", code: "turn-dropped" }),
    );
    expect(nudgeProvider.calls).toBe(0);
    expect(await userRows(chatSessionId)).toEqual(["Build it."]);
  });

  it("refuses auto-sent turns after Stop until the operator sends a message", async () => {
    const chatSessionId = await createChat("t664 latch");
    const t = gatedTools();
    const serializer = fastSerializer();
    const first = liveEditTurn({
      chatSessionId,
      provider: new BuildThenStage(),
      tools: t.tools,
      content: "Build it.",
      operator: true,
      serializer,
    });
    await t.running;
    await stopFromOtherInstance(chatSessionId);
    t.finish();
    await first;

    const nudge = new AnswerOnly();
    const refused = await liveEditTurn({
      chatSessionId,
      provider: nudge,
      tools: t.tools,
      content: "Approved: layouts proposal 1234abcd applied. Please continue.",
      operator: false,
      serializer,
    });
    expect(refused).toContainEqual(
      expect.objectContaining({ kind: "warning", code: "chat-stopped" }),
    );
    expect(nudge.calls).toBe(0);
    expect((await userRows(chatSessionId)).some((c) => c.startsWith("Approved"))).toBe(false);

    // The operator's own message lifts the latch …
    const operator = new AnswerOnly();
    await liveEditTurn({
      chatSessionId,
      provider: operator,
      tools: t.tools,
      content: "Continue with the hero only.",
      operator: true,
      serializer,
    });
    expect(operator.calls).toBe(1);
    // … and auto messages run again afterwards.
    const later = new AnswerOnly();
    await liveEditTurn({
      chatSessionId,
      provider: later,
      tools: t.tools,
      content: "Fix round 1 of 2.",
      operator: false,
      serializer,
    });
    expect(later.calls).toBe(1);
  });

  it("stops the subagents of a stopped turn", async () => {
    const chatSessionId = await createChat("t664 subagent stop");
    let childStepStarted!: () => void;
    const childRunning = new Promise<void>((r) => {
      childStepStarted = r;
    });
    let childAborted = false;
    // Step 1: the parent spawns. Step 2: the child's first step hangs until
    // aborted. Later steps: the parent's closing answer.
    class SpawnThenHang extends FixtureProvider {
      steps = 0;
      constructor() {
        super([], "claude-test-1");
      }
      protected override nextStepEvents(): readonly ProviderEvent[] {
        this.steps += 1;
        if (this.steps === 1) {
          return [
            {
              kind: "tool-call",
              id: "tc-spawn-664",
              name: "spawn_subagent",
              arguments: { role: "t664_builder", task: "Build the pricing page." },
            },
            { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
            { kind: "done", stopReason: "tool_use" },
          ];
        }
        return [
          { kind: "text-delta", text: "Stopped." },
          { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
          { kind: "done", stopReason: "end_turn" },
        ];
      }
      protected override nextStepStream(options: {
        abortSignal?: AbortSignal;
      }): ReadableStream<unknown> | null {
        if (this.steps !== 1) return null;
        // The child's step (the parent consumed step 1 already).
        this.steps += 1;
        childStepStarted();
        return new ReadableStream<unknown>({
          start(controller) {
            options.abortSignal?.addEventListener(
              "abort",
              () => {
                childAborted = true;
                controller.error(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
      }
    }
    const startedAt = Date.now();
    const turn = drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider: new SpawnThenHang(),
          tools: createDefaultToolRegistry(),
          aiCtx: AI,
          humanCtx: OWNER,
          turnSerializer: fastSerializer(),
          agentRunSource: "live_edit",
          operatorInitiated: true,
        },
        { chatSessionId, content: "Fan out the build.", chips: [] },
      ),
    );
    await childRunning;
    await waitFor(async () => (await listRuns(chatSessionId)).some((r) => r.kind === "subagent"));
    await stopFromOtherInstance(chatSessionId);
    await turn;
    expect(childAborted).toBe(true);
    // Well inside the subagent's own timeout: the Stop ended it.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(await listRuns(chatSessionId)).toHaveLength(0);
  });

  it("aborts a run on this instance at once through the local fast path", async () => {
    const chatSessionId = await createChat("t664 local abort");
    const started = await startAgentRun({
      store: {
        register: async () => ({ ok: true, registered: true, runId: "local-run-664" }),
        heartbeat: async () => ({ ok: true, cancelRequested: false, externalAgentRefusal: null }),
        finish: async () => undefined,
      },
      registration: {
        chatSessionId,
        kind: "turn",
        source: "live_edit",
        label: "Live Edit AI",
        operatorInitiated: true,
      },
      pollMs: 60_000,
    });
    if (started.kind !== "started") throw new Error("not started");
    expect(abortLocalAgentRuns(["local-run-664"])).toBe(1);
    expect(started.handle.signal.aborted).toBe(true);
    expect(started.handle.signal.reason).toBeInstanceOf(OperatorStoppedError);
    await started.handle.finish();
    expect(abortLocalAgentRuns(["local-run-664"])).toBe(0);
  });

  it("refuses a message that arrived before the Stop but registers after it (codex review)", async () => {
    const chatSessionId = await createChat("t664 pre-stop request");
    const epoch = await execute(registry, adapter, OWNER, "chat.get_agent_stop_epoch", {
      chatSessionId,
    });
    if (!epoch.ok) throw new Error(JSON.stringify(epoch.error));
    const arrivedAt = (epoch.value as { epoch: number }).epoch;
    // Stop lands while the request is still resolving its provider.
    await stopFromOtherInstance(chatSessionId);
    const late = new AnswerOnly();
    const events = await drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider: late,
          tools: new ToolRegistry(),
          aiCtx: AI,
          humanCtx: OWNER,
          turnSerializer: fastSerializer(),
          agentRunSource: "live_edit",
          operatorInitiated: true,
          stopEpochAtArrival: arrivedAt,
        },
        { chatSessionId, content: "Build the pricing page.", chips: [] },
      ),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "warning", code: "chat-stopped" }),
    );
    expect(late.calls).toBe(0);
    expect(await userRows(chatSessionId)).toEqual([]);

    // A message sent after the Stop runs (and lifts the latch).
    const after = await execute(registry, adapter, OWNER, "chat.get_agent_stop_epoch", {
      chatSessionId,
    });
    if (!after.ok) throw new Error(JSON.stringify(after.error));
    const fresh = new AnswerOnly();
    await drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider: fresh,
          tools: new ToolRegistry(),
          aiCtx: AI,
          humanCtx: OWNER,
          turnSerializer: fastSerializer(),
          agentRunSource: "live_edit",
          operatorInitiated: true,
          stopEpochAtArrival: (after.value as { epoch: number }).epoch,
        },
        { chatSessionId, content: "Now the hero only.", chips: [] },
      ),
    );
    expect(fresh.calls).toBe(1);
  });

  it("delivers Stop to a run whose row expired while its runner stalled (codex review)", async () => {
    const chatSessionId = await createChat("t664 expired run");
    const reg = await execute(registry, adapter, OWNER, "chat.register_agent_run", {
      chatSessionId,
      kind: "turn",
      source: "live_edit",
      label: "Live Edit AI",
      operatorInitiated: true,
    });
    if (!reg.ok) throw new Error(JSON.stringify(reg.error));
    const runId = (reg.value as { runId: string }).runId;
    await withSql(async (tx) => {
      await tx`UPDATE chat_agent_runs SET expires_at = now() - interval '1 second' WHERE id = ${runId}::uuid`;
    });
    await stopFromOtherInstance(chatSessionId);
    const beat = await execute(registry, adapter, OWNER, "chat.heartbeat_agent_run", { runId });
    expect(beat.ok && (beat.value as { cancelRequested: boolean }).cancelRequested).toBe(true);
    await execute(registry, adapter, OWNER, "chat.finish_agent_run", { runId });
  });

  it("drops a queued turn whose Stop surfaces only as it gets the chat (codex review)", async () => {
    const chatSessionId = await createChat("t664 stop at acquire");
    const t = gatedTools();
    const serializer = fastSerializer();
    const first = liveEditTurn({
      chatSessionId,
      provider: new BuildThenStage(),
      tools: t.tools,
      content: "Build it.",
      operator: true,
      serializer,
    });
    await t.running;
    // The queued turn's own cancel poll never fires in this test: only the
    // queued → running transition can surface the Stop.
    process.env.CAELO_AGENT_CANCEL_POLL_MS = "600000";
    const waiting = new AnswerOnly();
    let queued: Promise<ClientEvent[]>;
    try {
      queued = liveEditTurn({
        chatSessionId,
        provider: waiting,
        tools: t.tools,
        content: "Approve and continue.",
        operator: true,
        serializer,
      });
      await waitFor(async () => (await listRuns(chatSessionId)).length === 2);
    } finally {
      process.env.CAELO_AGENT_CANCEL_POLL_MS = "50";
    }
    const queuedRun = (await listRuns(chatSessionId)).find((r) => r.state === "queued");
    await stopFromOtherInstance(chatSessionId, queuedRun?.id);
    t.finish();
    await first;
    const events = await queued;
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "warning", code: "turn-dropped" }),
    );
    expect(waiting.calls).toBe(0);
    expect(await userRows(chatSessionId)).toEqual(["Build it."]);
  });

  it("refuses a turn by anyone but the chat's operator, before touching its Stop (codex review)", async () => {
    const chatSessionId = await createChat("t664 foreign turn");
    await stopFromOtherInstance(chatSessionId);
    const stranger: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000665",
      actorKind: "human",
      requestId: "t664-stranger",
    };
    await withSql(async (tx) => {
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${stranger.actorId}::uuid, 'human', 't664 stranger') ON CONFLICT (id) DO NOTHING`;
    });
    const r = await execute(registry, adapter, stranger, "chat.register_agent_run", {
      chatSessionId,
      kind: "turn",
      source: "live_edit",
      label: "Live Edit AI",
      operatorInitiated: true,
    });
    expect(r.ok).toBe(false);
    const latch = await withSql(async (tx) => {
      const rows =
        (await tx`SELECT agents_stopped_at FROM chat_sessions WHERE id = ${chatSessionId}::uuid`) as unknown as {
          agents_stopped_at: Date | null;
        }[];
      return rows[0]?.agents_stopped_at ?? null;
    });
    expect(latch).not.toBeNull();
  });

  it("only a human may Stop", async () => {
    const chatSessionId = await createChat("t664 authz");
    const r = await execute(registry, adapter, AI, "chat.cancel_agents", { chatSessionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
  });
});

describe("one agent per chat: Live Edit and Power-MCP (issue #665)", () => {
  async function mintAdminToken(): Promise<string> {
    const r = await execute(registry, adapter, OWNER, "mcp_tokens.create", {
      displayName: "t664 claude code",
      scope: "admin",
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as { plaintextToken: string }).plaintextToken;
  }

  async function mcpCall(token: string, chatSessionId: string, toolName: string, args: object) {
    const r = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
      plaintextToken: token,
      chatSessionId,
      toolName,
      args,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as { ok: boolean; content: string };
  }

  const navWrite = (slug: string) => ({
    kind: "nav-menu",
    slug,
    displayName: "t664 nav",
    items: [{ label: "Home", href: "/" }],
  });

  it("refuses a Live Edit turn while the external agent works, lists it, and Stop blocks it until allowed", async () => {
    const token = await mintAdminToken();
    const chatSessionId = await createChat("t664 mcp vs live edit");
    const write = await mcpCall(token, chatSessionId, "set_structured_set", navWrite("t664-a"));
    expect(write.ok).toBe(true);

    const runs = await listRuns(chatSessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "mcp", state: "running" });

    const blocked = new AnswerOnly();
    const events = await liveEditTurn({
      chatSessionId,
      provider: blocked,
      tools: new ToolRegistry(),
      content: "Build the homepage.",
      operator: true,
      serializer: fastSerializer(),
    });
    const error = events.find((e) => e.kind === "error");
    expect(error && "message" in error ? error.message : "").toContain("external agent");
    expect(blocked.calls).toBe(0);
    expect(await userRows(chatSessionId)).toEqual([]);

    // Stop the external agent: every later call in this chat is refused …
    const stop = await stopFromOtherInstance(chatSessionId, runs[0]?.id);
    expect(stop.stoppedExternalAgents).toBe(1);
    const refused = await mcpCall(token, chatSessionId, "set_structured_set", navWrite("t664-b"));
    expect(refused.ok).toBe(false);
    expect(refused.content).toStartWith("stopped_by_operator:");
    const readRefused = await mcpCall(token, chatSessionId, "list_pages", {});
    expect(readRefused.content).toStartWith("stopped_by_operator:");
    expect((await listRuns(chatSessionId))[0]).toMatchObject({ kind: "mcp", state: "stopped" });

    // … and the stopped agent no longer keeps the Live Edit AI out.
    const now = new AnswerOnly();
    await liveEditTurn({
      chatSessionId,
      provider: now,
      tools: new ToolRegistry(),
      content: "Build the homepage.",
      operator: true,
      serializer: fastSerializer(),
    });
    expect(now.calls).toBe(1);

    // "Allow again" lifts the block.
    const allowed = await execute(registry, adapterB, OWNER, "chat.allow_external_agent", {
      chatSessionId,
      runId: runs[0]?.id as string,
    });
    expect(allowed.ok && (allowed.value as { allowed: boolean }).allowed).toBe(true);
    const again = await mcpCall(token, chatSessionId, "set_structured_set", navWrite("t664-c"));
    expect(again.ok).toBe(true);
  });

  it("lets a Live Edit turn start once the external agent has been idle for the window", async () => {
    const token = await mintAdminToken();
    const chatSessionId = await createChat("t664 mcp idle");
    await mcpCall(token, chatSessionId, "list_pages", {});
    await Bun.sleep(1_700);
    const p = new AnswerOnly();
    await liveEditTurn({
      chatSessionId,
      provider: p,
      tools: new ToolRegistry(),
      content: "Now you.",
      operator: true,
      serializer: fastSerializer(),
    });
    expect(p.calls).toBe(1);
  });

  it("does not run a queued Live Edit turn once an external agent started while it waited (codex review)", async () => {
    const token = await mintAdminToken();
    const chatSessionId = await createChat("t664 queued vs mcp");
    const t = gatedTools();
    const serializer = fastSerializer();
    const first = liveEditTurn({
      chatSessionId,
      provider: new BuildThenStage(),
      tools: t.tools,
      content: "Build it.",
      operator: true,
      serializer,
    });
    await t.running;
    const waiting = new AnswerOnly();
    const queued = liveEditTurn({
      chatSessionId,
      provider: waiting,
      tools: t.tools,
      content: "Then the footer.",
      operator: true,
      serializer,
    });
    await waitFor(async () => (await listRuns(chatSessionId)).length === 2);
    // The external agent starts working while the second turn waits.
    expect((await mcpCall(token, chatSessionId, "list_pages", {})).ok).toBe(true);
    t.finish();
    await first;
    const events = await queued;
    const error = events.find((e) => e.kind === "error");
    expect(error && "message" in error ? error.message : "").toContain("external agent");
    expect(waiting.calls).toBe(0);
    expect(await userRows(chatSessionId)).toEqual(["Build it."]);
  });

  it("refuses an external write while a Live Edit turn writes; reads still work", async () => {
    const token = await mintAdminToken();
    const chatSessionId = await createChat("t664 live edit busy");
    const t = gatedTools();
    const turn = liveEditTurn({
      chatSessionId,
      provider: new BuildThenStage(),
      tools: t.tools,
      content: "Build it.",
      operator: true,
      serializer: fastSerializer(),
    });
    await t.running;

    const write = await mcpCall(token, chatSessionId, "set_structured_set", navWrite("t664-d"));
    expect(write.ok).toBe(false);
    expect(write.content).toStartWith("chat_busy:");
    const exists = await withSql(async (tx) => {
      const rows = (await tx`SELECT 1 FROM structured_sets WHERE slug = 't664-d'`) as unknown[];
      return rows.length > 0;
    });
    expect(exists).toBe(false);
    const read = await mcpCall(token, chatSessionId, "list_pages", {});
    expect(read.ok).toBe(true);

    t.finish();
    await turn;
    // The lease is free again once the turn ended.
    const after = await mcpCall(token, chatSessionId, "set_structured_set", navWrite("t664-e"));
    expect(after.ok).toBe(true);
  });
});
