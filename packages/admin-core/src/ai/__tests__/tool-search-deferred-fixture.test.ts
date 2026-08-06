// SPDX-License-Identifier: MPL-2.0

/**
 * Recording-derived CI ACCEPTANCE test — tool-search deferred result
 * (issue #442), flipped green by the SDK-loop migration.
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
 *   request 1 (the continuation): carries the dangling `server_tool_use`
 *     at the deferred-resume boundary; the API accepts it and delivers the
 *     deferred `tool_search_tool_result` as the next response's only
 *     content block.
 *
 * Pre-#442, our single-step chat-runner never issued request 1, so the
 * dangling call was (faithfully) persisted — the exact poison that wedged
 * dev session 57c2f0f5. Post-#442, `provider.generate` runs the SDK's own
 * multi-step loop: the client tool executes in-turn (every chat-runner tool
 * ships an `execute` now) and the deferred continuation is consumed before
 * the turn ends. Replaying BOTH recorded responses through the real
 * provider path must therefore assemble fully-paired turn-messages.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";

import type { ProviderEvent, ToolDefinition } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

// The tool-search threshold is forced for these replays; restore the
// ambient value so co-running test files see their own default.
let savedThreshold: string | undefined;
beforeAll(() => {
  savedThreshold = process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
});
afterAll(() => {
  if (savedThreshold === undefined) delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
  else process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = savedThreshold;
});

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

/** The recorded SSE responses, in request order (turn 1, continuation). */
function recordedResponses(lines: WireLine[]): string[] {
  return lines
    .filter((l) => l.dir === "response" && typeof l.sse === "string")
    .map((l) => {
      if (!l.sse) throw new Error("recording line lost its SSE");
      return l.sse;
    });
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
    // issue #442 — the chat-runner ships an execute for EVERY tool now; the
    // canned result mirrors what the live evidence run's SDK-loop leg used.
    execute: async () => "grab completed: 1024x768 png stored",
  },
  ...Array.from({ length: 11 }, (_v, i) => ({
    name: `filler_tool_${i}`,
    description: `Filler tool ${i} so the tool-search transform engages as in the recording.`,
    inputSchema: { type: "object" as const },
  })),
];

/** Replay the recorded SSE responses (turn 1, then the deferred-result
 * continuation) through the REAL provider path — the SDK loop issues the
 * continuation request itself, exactly as it did on the live wire. */
async function replayRecordedRun(): Promise<ProviderEvent[]> {
  process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = "5";
  const responses = recordedResponses(readRecording());
  let call = 0;
  const stubFetch = (async () => {
    const sse = responses[call];
    call += 1;
    if (sse === undefined) {
      throw new Error(
        `provider issued request ${call} but the recording only has ${responses.length} responses`,
      );
    }
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
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

describe("tool-search deferred result — recording-derived acceptance (#442)", () => {
  it("REGRESSION: replaying the recorded deferred turn yields fully-paired turn-messages", async () => {
    const { calls, results } = pairing(await replayRecordedRun());
    expect(calls.length).toBeGreaterThan(0);
    const dangling = calls.filter((id) => !results.includes(id));
    expect(dangling).toEqual([]);
  });

  it("the deferred search call is consumed in-turn: call AND result present in the assembly", async () => {
    const { calls, results } = pairing(await replayRecordedRun());
    expect(calls).toContain(SRV_ID);
    expect(results).toContain(SRV_ID);
  });

  it("the run is multi-step: the SDK loop issued the continuation the recording captured", async () => {
    const events = await replayRecordedRun();
    const stepStarts = events.filter((e) => e.kind === "step-start");
    expect(stepStarts.length).toBeGreaterThanOrEqual(2);
    const done = events.findLast((e) => e.kind === "done");
    expect(done?.kind === "done" ? done.stopReason : null).toBe("end_turn");
  });

  it("documents the wire evidence: deferred stream, dangling continuation request, deferred delivery in the next response", () => {
    const lines = readRecording();
    // Turn 1: both calls stream, no result block.
    const responses = recordedResponses(lines);
    const sse1 = responses[0] ?? "";
    expect(sse1).toContain('"server_tool_use"');
    expect(sse1).toContain(SRV_ID);
    expect(sse1).toContain(CLIENT_ID);
    expect(sse1).not.toContain('"tool_search_tool_result"');
    // Continuation request: dangling server_tool_use replayed verbatim at
    // the deferred-resume boundary, client pairing intact, no result block
    // anywhere in the request.
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
