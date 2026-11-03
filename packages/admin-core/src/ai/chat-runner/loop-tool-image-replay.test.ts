// SPDX-License-Identifier: MPL-2.0

/**
 * #1396 — a tool image replays exactly as the live turn sent it.
 *
 * The live turn delivers a tool's image through a follow-up user message
 * after the step's tool results. Before the fix, the replay
 * (`buildProviderHistory`) inlined images from user rows only, so the next
 * turn's history lacked that message: its request differed from the live one
 * at the image and the provider's prompt cache missed from there on (38–89k
 * tokens rewritten per turn after a `screenshot_page`, PR #1398).
 *
 * The test runs a real turn through `runToolLoop` (mock model at the
 * LanguageModel boundary, the SDK's own prompt conversion), persists its rows
 * the way `chat.append_message` / `chat.set_response_messages` do, replays
 * them for the next turn, and asserts the next turn's first request starts
 * with exactly the messages the live turn's last request carried.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, MediaStorageAdapter } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import { getMediaStorage, setMediaStorage } from "../../media/storage.js";
import type { ChatMessageInput, ProviderEvent } from "../provider.js";
import { MultiFixtureProvider } from "../providers/anthropic.js";
import { type ToolDefinitionWithHandler, ToolRegistry } from "../tools/dispatch.js";
import {
  buildProviderHistory,
  createMediaAttachmentLoader,
  type HistoryMessage,
} from "./attachments.js";
import { runToolLoop } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const HUMAN: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };

function screenshotTool(): ToolDefinitionWithHandler<Record<string, never>> {
  return {
    name: "screenshot_page",
    description: "returns an image",
    schema: z.object({}).strict(),
    inputSchema: { type: "object" },
    handler: async () => ({
      ok: true,
      content: "Screenshot captured.",
      image: { base64: PNG_1PX, mediaType: "image/png" as const },
    }),
  };
}

/** In-memory object store standing in for the chat-image bucket. */
function memoryStorage(): { adapter: MediaStorageAdapter; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const read = (key: string): Uint8Array => {
    const o = objects.get(key);
    if (!o) throw new Error(`ENOENT ${key}`);
    return o;
  };
  const adapter: MediaStorageAdapter = {
    put: async (key, bytes) => {
      objects.set(key, new Uint8Array(bytes));
    },
    get: async (key) => read(key),
    size: async (key) => read(key).byteLength,
    openStream: async () => {
      throw new Error("not used");
    },
    delete: async (key) => {
      objects.delete(key);
    },
    exists: async (key) => objects.has(key),
    totalSizeBytes: async () => 0,
  };
  return { adapter, objects };
}

/**
 * The chat_messages rows a turn writes, kept the way the session read
 * returns them (`HistoryMessage`), plus the dedup-cache ops the dispatcher
 * calls.
 */
function chatStore(): {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  rows: (HistoryMessage & { id: string })[];
} {
  const rows: (HistoryMessage & { id: string })[] = [];
  const registry = new OperationRegistry();
  const op = (name: string, handler: (input: Record<string, unknown>) => unknown) =>
    registry.register(
      defineOperation({
        name,
        readScope: "request",
        actorScope: ["human", "ai", "system"],
        database: "cms_admin",
        input: z.looseObject({}),
        output: z.looseObject({}),
        handler: async (_ctx, input) => ok(handler(input as Record<string, unknown>) as object),
      }),
    );
  op("chat.append_message", (input) => {
    const id = crypto.randomUUID();
    const attachments = input.attachments as HistoryMessage["attachments"];
    rows.push({
      id,
      role: input.role as HistoryMessage["role"],
      content: input.content as string,
      toolCalls: input.toolCalls ?? null,
      toolCallId: (input.toolCallId as string | undefined) ?? null,
      thinkingBlocks: (input.thinkingBlocks as HistoryMessage["thinkingBlocks"]) ?? null,
      attachments: attachments && attachments.length > 0 ? attachments : null,
      responseMessages: (input.responseMessages as unknown[] | null | undefined) ?? null,
    });
    return { messageId: id };
  });
  op("chat.set_response_messages", (input) => {
    const row = rows.find((r) => r.id === input.messageId);
    if (!row) throw new Error("unknown message");
    row.responseMessages = input.responseMessages as unknown[];
    return {};
  });
  op("chat.lookup_tool_result", () => ({ cached: null }));
  op("chat.cache_tool_result", () => ({}));
  const adapter = {
    runOperation: (
      o: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => o.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter, rows };
}

async function runTurn(
  store: ReturnType<typeof chatStore>,
  provider: MultiFixtureProvider,
  initialMessages: ChatMessageInput[],
): Promise<void> {
  const tools = new ToolRegistry();
  tools.register(screenshotTool());
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const gen = runToolLoop({
    registry: store.registry,
    adapter: store.adapter,
    humanCtx: HUMAN,
    aiCtxWithBranch: { ...HUMAN, actorId: "ai-1", actorKind: "ai" },
    provider,
    tools,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-image-replay",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "static system prompt",
    filteredTools: [
      { name: "screenshot_page", description: "returns an image", inputSchema: { type: "object" } },
    ],
    initialMessages,
    compactionThresholdTokens: 600_000,
    maxLoops: 5,
    maxOutputTokens: 16384,
    temperature: undefined,
    thinkingBudget: null,
    usage,
    costCapMicrocents: undefined,
    inputCost: 15,
    outputCost: 75,
  });
  const events: ClientEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) break;
    events.push(step.value);
  }
}

/** A user row exactly as `chat.append_message` would store the operator's message. */
function appendUser(store: ReturnType<typeof chatStore>, content: string): void {
  store.rows.push({
    id: crypto.randomUUID(),
    role: "user",
    content,
    toolCalls: null,
    toolCallId: null,
    thinkingBlocks: null,
    attachments: null,
    responseMessages: null,
  });
}

const replay = (store: ReturnType<typeof chatStore>) =>
  buildProviderHistory(
    store.rows,
    createMediaAttachmentLoader(store.registry, store.adapter, HUMAN),
  );

const screenshotStep: readonly ProviderEvent[] = [
  { kind: "tool-call", id: "call-shot-1", name: "screenshot_page", arguments: {} },
  { kind: "tool-call", id: "call-shot-2", name: "screenshot_page", arguments: {} },
  { kind: "usage", inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
  { kind: "done", stopReason: "tool_use" },
];
const answer = (text: string): readonly ProviderEvent[] => [
  { kind: "text-delta", text },
  { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
  { kind: "done", stopReason: "end_turn" },
];

let previousStorage: MediaStorageAdapter | null = null;
function useStorage(adapter: MediaStorageAdapter): void {
  try {
    previousStorage = getMediaStorage();
  } catch {
    previousStorage = null;
  }
  setMediaStorage(adapter);
}
afterEach(() => {
  if (previousStorage) setMediaStorage(previousStorage);
});

/** User messages of a LanguageModel prompt that carry a non-text part. */
const imageMessages = (prompt: readonly unknown[]) =>
  prompt.filter((raw) => {
    const m = raw as { role?: string; content?: unknown };
    return (
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { type?: string }).type !== "text")
    );
  });

describe("tool images replay byte-identical to the live turn (#1396)", () => {
  it("the next turn's request starts with exactly what the live turn sent", async () => {
    const { adapter: storage } = memoryStorage();
    useStorage(storage);
    const store = chatStore();

    appendUser(store, "screenshot the homepage on desktop and mobile");
    const turn1 = new MultiFixtureProvider([screenshotStep, answer("Both look fine.")]);
    await runTurn(store, turn1, await replay(store));
    const liveLast = turn1.seenPrompts.at(-1);
    expect(liveLast).toBeDefined();
    // The live continuation step saw both screenshots.
    expect(imageMessages(liveLast ?? [])).toHaveLength(2);

    appendUser(store, "now make the hero bigger");
    const turn2 = new MultiFixtureProvider([answer("Done.")]);
    await runTurn(store, turn2, await replay(store));
    const replayFirst = turn2.seenPrompts[0] ?? [];

    // Byte-identical prefix: everything the live turn's last request carried
    // comes back unchanged and in the same order, so the provider's cached
    // prefix stays valid. What follows is the turn's own answer + the new ask.
    const live = liveLast ?? [];
    expect(JSON.stringify(replayFirst.slice(0, live.length))).toBe(JSON.stringify(live));
    expect(replayFirst.length).toBe(live.length + 2);
    // ...and the AI still sees both earlier screenshots in the later turn.
    expect(imageMessages(replayFirst)).toHaveLength(2);
  });

  it("a stored image that is gone keeps its message, with a note instead of the image", async () => {
    const { adapter: storage, objects } = memoryStorage();
    useStorage(storage);
    const store = chatStore();

    appendUser(store, "screenshot the homepage");
    const turn1 = new MultiFixtureProvider([screenshotStep, answer("Looks fine.")]);
    await runTurn(store, turn1, await replay(store));
    const liveLast = turn1.seenPrompts.at(-1) ?? [];

    // The object vanished under a still-referenced row (deleted out of band,
    // or a sweep that ran before the reference was cleared).
    objects.clear();
    appendUser(store, "and now?");
    const turn2 = new MultiFixtureProvider([answer("Done.")]);
    await runTurn(store, turn2, await replay(store));
    const replayFirst = turn2.seenPrompts[0] ?? [];

    // Same message count and roles as the live request — the history keeps
    // its shape (tool results first, then one follow-up per image)...
    const roles = (p: readonly unknown[]) => p.map((m) => (m as { role?: string }).role);
    expect(roles(replayFirst.slice(0, liveLast.length))).toEqual(roles(liveLast));
    // ...no image is sent, and each follow-up tells the model why.
    expect(imageMessages(replayFirst)).toHaveLength(0);
    const notes = JSON.stringify(replayFirst).match(/could NOT be loaded/g) ?? [];
    expect(notes).toHaveLength(2);
  });
});
