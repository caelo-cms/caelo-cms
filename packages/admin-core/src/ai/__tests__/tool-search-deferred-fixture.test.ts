// SPDX-License-Identifier: MPL-2.0

/**
 * Recording-derived CI regression — tool-search deferred result.
 *
 * The fixtures under `fixtures/tool-search-deferred/` are VERBATIM wire
 * recordings of the live evidence run (operator-executed, 2026-08-06,
 * `claude-haiku-4-5`, ai@7.0.55 + @ai-sdk/anthropic@4.0.33 — see
 * `live-*-evidence.json` for the run summary). They were captured by the
 * provider's `CAELO_DEBUG_AI_WIRE` tap during `tool-search-deferred-live.test.ts`;
 * nothing in this file is hand-authored SSE.
 *
 * What the recording shows (and this test pins into CI, network-free):
 *
 *   request 0 (turn 1): the model streams `server_tool_use`
 *     (tool_search_tool_bm25) + a client `tool_use` in ONE response and the
 *     API defers the search result — NO `tool_search_tool_result` block in
 *     the stream.
 *   request 2 (continuation): our Option-C replay carries the dangling
 *     `server_tool_use`; the API accepts it and delivers the deferred
 *     `tool_search_tool_result` as the next response's only content block.
 *
 * Tests:
 *   1. REGRESSION [expected fail until the SDK-loop migration lands]:
 *      replaying the recorded turn-1 SSE through the real provider path
 *      must yield turn-messages whose providerExecuted calls are all
 *      paired. Today the dangling call is (faithfully) persisted — the
 *      exact poison that wedged dev session 57c2f0f5.
 *   2. documents: the assembled turn-messages carry the dangling call.
 *   3. documents: pure data assertions on the recording — the deferred
 *      turn-1 stream, the dangling continuation request, and the API's
 *      deferred result delivery.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";

import type { ProviderEvent, ToolDefinition } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "tool-search-deferred");
const RUN_A = "live-2026-08-06T08-49-36.375Z-runA-wire.raw.jsonl";
const SRV_ID = "srvtoolu_01Sj6goooDYboY4chfGvPaVC";
const CLIENT_ID = "toolu_01FLoh1e2EE5v1CqMVP5F2cv";

interface WireLine {
  dir: "request" | "response";
  status?: number;
  body?: { messages?: { role?: string; content?: unknown }[] };
  sse?: string;
}

function readRecording(): WireLine[] {
  return readFileSync(join(FIXTURES_DIR, RUN_A), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as WireLine);
}

/** The recorded turn-1 SSE (deferred shape). */
function turnOneSse(lines: WireLine[]): string {
  const first = lines.find((l) => l.dir === "response" && typeof l.sse === "string");
  if (!first?.sse) throw new Error("recording missing turn-1 SSE");
  return first.sse;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "capture_screen_grab",
    description: "Take a still image of a website address and report the stored image size.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
    alwaysLoaded: true,
  },
  ...Array.from({ length: 11 }, (_v, i) => ({
    name: `filler_tool_${i}`,
    description: `Filler tool ${i} so the tool-search transform engages as in the recording.`,
    inputSchema: { type: "object" as const },
  })),
];

/** Replay the recorded turn-1 SSE through the REAL provider translation +
 * Option C assembly (stub fetch serving the recording verbatim). */
async function replayTurnOne(): Promise<ProviderEvent[]> {
  process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = "5";
  const sse = turnOneSse(readRecording());
  const stubFetch = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  const model = createAnthropic({ apiKey: "offline-fixture", fetch: stubFetch })(
    "claude-haiku-4-5",
  );
  const provider = new AnthropicProvider({
    apiKey: "offline-fixture",
    model: "claude-haiku-4-5",
    toolSearch: "bm25",
    _modelOverride: model,
  });
  const events: ProviderEvent[] = [];
  for await (const e of provider.generate({
    systemPrompt: "fixture replay",
    messages: [{ role: "user", content: "Run the two calls now, exactly as instructed." }],
    tools: TOOLS,
    maxTokens: 1000,
  })) {
    events.push(e);
  }
  return events;
}

interface SdkPart {
  type?: string;
  toolCallId?: string;
  providerExecuted?: boolean;
}

function pairing(events: ProviderEvent[]): { calls: string[]; results: string[] } {
  const turn = events.find((e) => e.kind === "turn-messages");
  const calls: string[] = [];
  const results: string[] = [];
  if (turn?.kind === "turn-messages") {
    for (const m of turn.messages) {
      const content = (m as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const p of content as SdkPart[]) {
        if (p.type === "tool-call" && p.providerExecuted && p.toolCallId) calls.push(p.toolCallId);
        if (p.type === "tool-result" && p.toolCallId) results.push(p.toolCallId);
      }
    }
  }
  return { calls, results };
}

describe("tool-search deferred result — recording-derived regression", () => {
  it("REGRESSION: replaying the recorded deferred turn yields fully-paired turn-messages [EXPECTED FAIL until the SDK-loop migration lands]", async () => {
    const { calls, results } = pairing(await replayTurnOne());
    expect(calls.length).toBeGreaterThan(0);
    const dangling = calls.filter((id) => !results.includes(id));
    expect(dangling).toEqual([]);
  });

  it("documents today's defect: the recorded deferred turn assembles a dangling providerExecuted call", async () => {
    const { calls, results } = pairing(await replayTurnOne());
    expect(calls).toContain(SRV_ID);
    expect(results).not.toContain(SRV_ID);
  });

  it("documents the wire evidence: deferred stream, dangling continuation request, deferred delivery in the next response", () => {
    const lines = readRecording();
    // Turn 1: both calls stream, no result block.
    const sse1 = turnOneSse(lines);
    expect(sse1).toContain('"server_tool_use"');
    expect(sse1).toContain(SRV_ID);
    expect(sse1).toContain(CLIENT_ID);
    expect(sse1).not.toContain('"tool_search_tool_result"');
    // Continuation request: dangling server_tool_use replayed verbatim,
    // client pairing intact, no result block anywhere in the request.
    const cont = lines.filter((l) => l.dir === "request").at(-1);
    const contJson = JSON.stringify(cont?.body ?? {});
    expect(contJson).toContain('"server_tool_use"');
    expect(contJson).toContain(SRV_ID);
    expect(contJson).toContain('"tool_result"');
    expect(contJson).not.toContain('"tool_search_tool_result"');
    // Continuation response: the API accepted the dangling replay and
    // delivered the deferred result as the next response's content.
    const contResponse = lines.filter((l) => l.dir === "response").at(-1);
    expect(contResponse?.status).toBe(200);
    expect(contResponse?.sse ?? "").toContain('"tool_search_tool_result"');
  });
});
