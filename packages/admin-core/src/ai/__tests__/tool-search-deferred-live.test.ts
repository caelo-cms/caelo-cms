// SPDX-License-Identifier: MPL-2.0

/**
 * LIVE repro — tool-search deferred-result 400 wedge.
 *
 * Observed in dev (session 57c2f0f5, 2026-08-06 ~07:47 UTC): an assistant
 * turn whose persisted `response_messages` carry a providerExecuted
 * `tool_search_tool_bm25` tool-call WITHOUT its paired tool-result, plus a
 * client tool-call in the same turn. The next (loop-continuation) request
 * replays that assembly verbatim (Option C) and Anthropic rejects it:
 *
 *   messages.5: tool_search_tool_bm25 tool use with id srvtoolu_… was found
 *   without a corresponding tool_search_tool_bm25_tool_result block
 *
 * Working hypothesis (upstream vercel/ai#11849, #11931): when the model
 * emits the tool-search call AND a client tool call in the SAME assistant
 * turn, the Anthropic API does NOT insert the search result into that
 * response — it defers it to the next response. The AI SDK models this via
 * `supportsDeferredResults: true` on the tool-search factories and
 * auto-continues its own loop; Caelo's chat-runner owns the loop
 * (single-step calls, CLAUDE.md §12 "by design"), so nothing consumes the
 * deferred-continuation semantic and the replayed dangling `server_tool_use`
 * 400s.
 *
 * This suite drives the REAL Anthropic API (operator-sanctioned for this
 * repro — hand-crafted SSE mocks were explicitly rejected as conjecture):
 *
 *   run A — the exact chat-runner path (AnthropicProvider with
 *           toolSearch:"bm25" + deferLoading transform). Prompts the model
 *           into the defective shape: a bm25 search whose query matches
 *           nothing in the catalogue ("map external page types") plus a
 *           client tool call in the same turn. Asserts the Option C
 *           invariant (every providerExecuted call paired) and that the
 *           continuation replay does not 400. BOTH assertions are EXPECTED
 *           TO FAIL on the current SDK when the deferred shape reproduces —
 *           that failure is the proof.
 *
 *   run B — the SDK-native loop (plain streamText, client tool WITH
 *           execute, stopWhen stepCountIs(3)). Informative: records what a
 *           continuation looks like when the SDK's own deferred-result
 *           machinery drives it, so run A's rejected request can be diffed
 *           against a working (or equally broken) upstream shape.
 *
 * Raw wire traffic (verbatim request bodies + SSE) is recorded through the
 * existing CAELO_DEBUG_AI_WIRE tap (run A) and a local recorder (run B)
 * into __tests__/fixtures/tool-search-deferred/. The CI-safe regression
 * fixture is derived from these recordings, never hand-authored.
 *
 * GATING (CLAUDE.md §6 — live tests are opt-in, never PR CI):
 *   CAELO_LIVE_AI=1 + ANTHROPIC_API_KEY must both be set, else every test
 *   here is skipped. Cost: ≤ 5 small requests against claude-haiku-4-5
 *   (< $0.01); token usage is logged at the end of the run. The key is
 *   read from the environment only and never logged (the wire tap records
 *   bodies, not headers).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { anthropic as anthropicGlobal } from "@ai-sdk/anthropic";
import { createAnthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText } from "ai";

import { buildProviderHistory, type HistoryMessage } from "../chat-runner/attachments.js";
import type {
  ChatMessageInput,
  GenerateInput,
  ProviderEvent,
  ToolDefinition,
} from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

/**
 * Key resolution: `ANTHROPIC_API_KEY` from the process env, else — when
 * `CAELO_LIVE_AI_ENV_FILE` names an env file (e.g. the dev install's root
 * `.env`) — the `ANTHROPIC_API_KEY=` line from that file. The file path
 * travels through the shell; the key itself never does, and it is never
 * logged (the wire tap records bodies, not headers).
 */
function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envFile = process.env.CAELO_LIVE_AI_ENV_FILE;
  if (!envFile) return undefined;
  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^ANTHROPIC_API_KEY=("?)(.+)\1\s*$/.exec(line.trim());
      if (m?.[2]) return m[2];
    }
  } catch {
    /* unreadable env file — treated as no key */
  }
  return undefined;
}

const API_KEY = resolveApiKey();
const LIVE = process.env.CAELO_LIVE_AI === "1" && typeof API_KEY === "string" && API_KEY.length > 0;
const MODEL = process.env.CAELO_LIVE_AI_MODEL ?? "claude-haiku-4-5";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "tool-search-deferred");

const req = createRequire(import.meta.url);
function pkgVersion(name: string): string {
  try {
    return (req(`${name}/package.json`) as { version: string }).version;
  } catch {
    return "unknown";
  }
}
const SDK_VERSIONS = {
  ai: pkgVersion("ai"),
  "@ai-sdk/anthropic": pkgVersion("@ai-sdk/anthropic"),
};

/* ------------------------------------------------------------------ */
/* Tool catalogue                                                      */
/* ------------------------------------------------------------------ */

/**
 * 11 deferred junk tools. Names, descriptions, and argument names
 * deliberately avoid every term of the search query ("map external page
 * types") so the BM25 search returns ZERO tool_references — the observed
 * trigger shape from the wedged session.
 */
const JUNK_TOOL_NAMES = [
  "ledger_entry_sum",
  "invoice_draft_create",
  "warehouse_bin_count",
  "payroll_run_start",
  "shipment_label_print",
  "vendor_contact_merge",
  "tax_rate_lookup",
  "budget_line_adjust",
  "receipt_ocr_queue",
  "timesheet_week_close",
  "expense_policy_check",
] as const;

function junkTools(): ToolDefinition[] {
  return JUNK_TOOL_NAMES.map((name) => ({
    name,
    description: `Accounting utility: ${name.replaceAll("_", " ")}.`,
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "free-form note" } },
    },
  }));
}

/** The client tool the model pairs with the search call (mirrors the real
 * defect's screenshot tool; renamed so it cannot match the query). */
const GRAB_TOOL: ToolDefinition = {
  name: "capture_screen_grab",
  description: "Take a still image of a website address and report the stored image size.",
  inputSchema: {
    type: "object",
    properties: { address: { type: "string", description: "the website address" } },
    required: ["address"],
  },
  alwaysLoaded: true,
};

const TOOLS: ToolDefinition[] = [GRAB_TOOL, ...junkTools()];

const SYSTEM_PROMPT = [
  "You are a wire-format test driver. Follow these instructions EXACTLY.",
  "In your first response, emit exactly two tool calls TOGETHER in the same",
  "assistant turn, and nothing else (no prose, no explanations):",
  '1. tool_search_tool_bm25 with input {"query": "map external page types"}',
  '2. capture_screen_grab with input {"address": "https://example.com/"}',
  "Emit both calls in parallel. Do NOT wait for the search result before",
  "calling capture_screen_grab. Do not write any text.",
].join("\n");

const USER_MESSAGE = "Run the two calls now, exactly as instructed.";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function drain(p: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of p) out.push(e);
  return out;
}

interface SdkPart {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  providerExecuted?: boolean;
}

/** Walk SDK ModelMessages; return providerExecuted tool-call ids that have
 * no matching tool-result part anywhere in the assembly. */
function danglingProviderCallIds(messages: readonly unknown[]): string[] {
  const callIds = new Map<string, string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content as SdkPart[]) {
      if (part.type === "tool-call" && part.providerExecuted && part.toolCallId) {
        callIds.set(part.toolCallId, part.toolName ?? "?");
      }
      if (part.type === "tool-result" && part.toolCallId) {
        resultIds.add(part.toolCallId);
      }
    }
  }
  return [...callIds.keys()].filter((id) => !resultIds.has(id));
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

function addUsage(usage: Usage, events: readonly ProviderEvent[]): void {
  usage.requests += 1;
  for (const e of events) {
    if (e.kind === "usage") {
      usage.inputTokens += e.inputTokens;
      usage.outputTokens += e.outputTokens;
    }
  }
}

/** Minimal wire recorder for run B (run A uses the provider's built-in
 * CAELO_DEBUG_AI_WIRE tap). Records bodies only — never headers. */
function recordingFetch(rawPath: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const stamp = new Date().toISOString();
    if (init?.body && typeof init.body === "string") {
      let body: unknown = init.body;
      try {
        body = JSON.parse(init.body);
      } catch {
        /* keep raw */
      }
      appendFileSync(rawPath, `${JSON.stringify({ dir: "request", stamp, body })}\n`);
    }
    const res = await fetch(input as RequestInfo, init);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const text = await res.clone().text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw */
      }
      appendFileSync(
        rawPath,
        `${JSON.stringify({ dir: "response", stamp, status: res.status, body: parsed })}\n`,
      );
      return res;
    }
    if (res.body) {
      const [a, b] = res.body.tee();
      void (async () => {
        try {
          const chunks: string[] = [];
          const reader = a.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(dec.decode(value, { stream: true }));
          }
          appendFileSync(
            rawPath,
            `${JSON.stringify({ dir: "response", stamp, status: res.status, sse: chunks.join("") })}\n`,
          );
        } catch {
          /* best-effort */
        }
      })();
      return new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  }) as typeof fetch;
}

/* ------------------------------------------------------------------ */
/* Shared live-run state (populated once in beforeAll)                 */
/* ------------------------------------------------------------------ */

interface LiveState {
  fatal?: string;
  attempts: number;
  /** "deferred" (defect shape), "in-turn" (healthy), or "other". */
  turnShape?: string;
  turnMessages?: readonly unknown[];
  dangling?: string[];
  clientCallId?: string;
  continuationErrors?: string[];
  continuationStop?: string;
  sdkLoopOutcome?: string;
  sdkLoopDangling?: string[];
  usage: Usage;
}

const S: LiveState = { attempts: 0, usage: { inputTokens: 0, outputTokens: 0, requests: 0 } };

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("LIVE — tool-search deferred result wedge (real Anthropic API)", () => {
  beforeAll(async () => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const wireBase = join(FIXTURES_DIR, `live-${stamp}-runA-wire`);
    // Enable the provider's built-in raw wire tap BEFORE construction.
    process.env.CAELO_DEBUG_AI_WIRE = "1";
    process.env.CAELO_AI_WIRE_LOG = wireBase;
    process.env.CAELO_DEBUG_TOOL_SEARCH = "1";
    // Deterministic engagement regardless of ambient env.
    process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = "5";

    try {
      const provider = new AnthropicProvider({
        apiKey: API_KEY as string,
        model: MODEL,
        toolSearch: "bm25",
      });

      /* ---- run A, turn 1: elicit the defective shape ---- */
      const baseInput: GenerateInput = {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: USER_MESSAGE }],
        tools: TOOLS,
        maxTokens: 1000,
      };

      let turnEvents: ProviderEvent[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        S.attempts = attempt;
        turnEvents = await drain(provider.generate(baseInput));
        addUsage(S.usage, turnEvents);
        const serverCall = turnEvents.find(
          (e) => e.kind === "server-tool-call" && e.name.startsWith("tool_search_tool"),
        );
        const serverResult = turnEvents.find((e) => e.kind === "server-tool-result");
        const clientCall = turnEvents.find(
          (e) => e.kind === "tool-call" && e.name === GRAB_TOOL.name,
        );
        const turnMessagesEvent = turnEvents.find((e) => e.kind === "turn-messages");
        S.turnMessages =
          turnMessagesEvent?.kind === "turn-messages" ? turnMessagesEvent.messages : undefined;
        S.clientCallId = clientCall?.kind === "tool-call" ? clientCall.id : undefined;
        if (serverCall && clientCall && !serverResult) {
          S.turnShape = "deferred";
          break;
        }
        S.turnShape = serverCall && serverResult ? "in-turn" : "other";
      }
      S.dangling = S.turnMessages ? danglingProviderCallIds(S.turnMessages) : [];

      /* ---- run A, turn 2: the chat-runner-shaped continuation ---- */
      if (S.turnMessages && S.clientCallId) {
        const rows: ChatMessageInput[] = [
          { role: "user", content: USER_MESSAGE },
          // Exactly what the chat-runner persists + replays (Option C
          // passthrough; loop.ts:795 / attachments.ts:156-159).
          { role: "assistant", content: "", sdkMessages: S.turnMessages },
          {
            role: "tool",
            content: "grab completed: 1024x768 png stored",
            toolCallId: S.clientCallId,
          },
        ];
        const contEvents = await drain(
          provider.generate({ ...baseInput, messages: rows, maxTokens: 400 }),
        );
        addUsage(S.usage, contEvents);
        S.continuationErrors = contEvents
          .filter((e) => e.kind === "error")
          .map((e) => (e.kind === "error" ? e.message : ""));
        const done = contEvents.find((e) => e.kind === "done");
        S.continuationStop = done?.kind === "done" ? done.stopReason : undefined;
      }

      /* ---- run B: SDK-native loop with execute (informative) ---- */
      try {
        const rawB = join(FIXTURES_DIR, `live-${stamp}-runB-wire.raw.jsonl`);
        const prov = createAnthropic({ apiKey: API_KEY as string, fetch: recordingFetch(rawB) });
        const deferLoading = { providerOptions: { anthropic: { deferLoading: true } } };
        const { jsonSchema } = await import("ai");
        const sdkTools: Record<string, unknown> = {
          [GRAB_TOOL.name]: {
            description: GRAB_TOOL.description,
            inputSchema: jsonSchema(GRAB_TOOL.inputSchema),
            execute: async () => "grab completed: 1024x768 png stored",
          },
          tool_search_tool_bm25: anthropicGlobal.tools.toolSearchBm25_20251119(),
        };
        for (const t of junkTools()) {
          sdkTools[t.name] = {
            description: t.description,
            inputSchema: jsonSchema(t.inputSchema),
            ...deferLoading,
          };
        }
        const result = streamText({
          model: prov(MODEL as Parameters<typeof prov>[0]),
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: USER_MESSAGE }],
          tools: sdkTools as Parameters<typeof streamText>[0]["tools"],
          stopWhen: stepCountIs(3),
          maxOutputTokens: 1000,
        });
        const bErrors: string[] = [];
        for await (const part of result.fullStream) {
          if (part.type === "error") {
            const err = (part as { error?: unknown }).error;
            bErrors.push(err instanceof Error ? err.message : String(err));
          }
        }
        const bMessages = await result.responseMessages;
        S.sdkLoopDangling = danglingProviderCallIds(bMessages as unknown[]);
        S.usage.requests += 1;
        S.sdkLoopOutcome =
          bErrors.length > 0
            ? `errors: ${bErrors.join(" | ")}`
            : `completed; messages=${(bMessages as unknown[]).length}; dangling=${JSON.stringify(S.sdkLoopDangling)}`;
      } catch (err) {
        S.sdkLoopOutcome = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    } catch (err) {
      S.fatal = err instanceof Error ? err.message : String(err);
    } finally {
      /* ---- evidence dump (written even when assertions will fail) ---- */
      const evidence = {
        recordedAt: new Date().toISOString(),
        model: MODEL,
        sdkVersions: SDK_VERSIONS,
        attempts: S.attempts,
        turnShape: S.turnShape,
        dangling: S.dangling,
        continuationErrors: S.continuationErrors,
        continuationStop: S.continuationStop,
        sdkLoopOutcome: S.sdkLoopOutcome,
        usage: S.usage,
        fatal: S.fatal,
        turnMessages: S.turnMessages,
      };
      writeFileSync(
        join(FIXTURES_DIR, `live-${new Date().toISOString().replaceAll(":", "-")}-evidence.json`),
        JSON.stringify(evidence, null, 2),
      );
    }
  }, 180_000);

  afterAll(() => {
    // Cost report (haiku 4.5: $1/MTok in, $5/MTok out).
    const price =
      MODEL === "claude-haiku-4-5"
        ? (S.usage.inputTokens / 1e6) * 1 + (S.usage.outputTokens / 1e6) * 5
        : null;
    console.log("[live-repro] usage", {
      model: MODEL,
      sdkVersions: SDK_VERSIONS,
      ...S.usage,
      estimatedUsd: price !== null ? price.toFixed(5) : "unknown model pricing",
      turnShape: S.turnShape,
      attempts: S.attempts,
      sdkLoopOutcome: S.sdkLoopOutcome,
    });
  });

  it("elicited the defective wire shape (search + client call, same turn)", () => {
    expect(S.fatal).toBeUndefined();
    // If this fails with "in-turn", the API inserted the search result in
    // the same response on every attempt — the deferred shape did not
    // reproduce and the run is inconclusive (retry, or switch model via
    // CAELO_LIVE_AI_MODEL).
    expect(S.turnShape).toBe("deferred");
  });

  it("Option C invariant: every providerExecuted tool-search call in responseMessages is paired with its result [EXPECTED FAIL on current SDK]", () => {
    expect(S.fatal).toBeUndefined();
    expect(S.turnMessages).toBeDefined();
    // PROOF ASSERTION #1 — on the current SDK the deferred turn's
    // assembly carries the dangling call, so this fails, reproducing the
    // persisted defective row from the wedged session.
    expect(S.dangling).toEqual([]);
  });

  it("replaying the persisted turn + client tool result does not 400 [EXPECTED FAIL on current SDK]", () => {
    expect(S.fatal).toBeUndefined();
    // PROOF ASSERTION #2 — the loop-continuation request built from the
    // verbatim Option C passthrough is rejected by the live API with the
    // exact production error ("… was found without a corresponding
    // tool_search_tool_bm25_tool_result block").
    expect(S.continuationErrors ?? []).toEqual([]);
    expect(S.continuationStop).not.toBe("error");
  });

  it("history repair leaves the defective passthrough row untouched (documents the wedge's permanence)", async () => {
    expect(S.fatal).toBeUndefined();
    expect(S.turnMessages).toBeDefined();
    const history: HistoryMessage[] = [
      { role: "user", content: USER_MESSAGE, toolCalls: null, toolCallId: null, thinkingBlocks: null },
      {
        role: "assistant",
        content: "",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: null,
        responseMessages: [...(S.turnMessages as unknown[])],
      },
      {
        role: "tool",
        content: "grab completed: 1024x768 png stored",
        toolCalls: null,
        thinkingBlocks: null,
        toolCallId: S.clientCallId ?? "missing",
      },
    ];
    const noImages = async () => ({ failed: "no loader in this test" }) as const;
    const out = await buildProviderHistory(history, noImages);
    // history-repair.ts:127-130 — passthrough rows replay verbatim; the
    // dangling providerExecuted call inside is invisible to the repair.
    // This is WHY the wedge is permanent: no later turn can heal it.
    expect(out).toHaveLength(3);
    expect(out[1]?.sdkMessages).toEqual([...(S.turnMessages as unknown[])]);
  });
});
