// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.71 — Vercel AI SDK spike preflight: verify the SDK preserves
 * Anthropic thinking-block signatures across the response.messages
 * round-trip. This is the riskiest of the three v0.3.0 migration
 * preflights (the thinking-signature one).
 *
 * Why we care: Anthropic returns 400 on a tool-use continuation if
 * the assistant message's thinking blocks are stripped or have
 * tampered signatures. Caelo's hand-rolled provider preserves
 * `{thinking, signature}` pairs explicitly through the runner +
 * persists to `chat_messages.thinking_blocks`. If we migrate to
 * the SDK, the SDK's response.messages must carry the signature
 * (via providerMetadata.anthropic.signature) AND the SDK must
 * re-serialize it back to the wire format on the next call.
 *
 * Spike setup:
 *  1. Mock the LanguageModelV2 with a stream that emits reasoning-*
 *     events carrying a signature (mimicking Anthropic's
 *     thinking_delta + signature_delta).
 *  2. Call streamText → collect response.messages.
 *  3. Inspect: assistant message should have a `reasoning` content
 *     part with `providerMetadata.anthropic.signature`.
 *  4. Call streamText AGAIN with `messages = previous response.messages`.
 *  5. Inspect the mock's recorded prompt — the assistant turn must
 *     include the reasoning content with the SAME signature in the
 *     providerMetadata. Confirms the SDK's request serializer
 *     reads back the signature we received.
 *
 * If this test passes, the v0.3.0 migration is unblocked on the
 * thinking-signature concern. (Production verification —
 * Anthropic's actual signature-acceptance — still requires a real
 * API smoke before declaring v0.3.0 GA.)
 */

import { describe, expect, it } from "bun:test";
import { streamText } from "ai";
import { MockLanguageModelV2 } from "ai/test";

// Hand-rolled stream constructor — avoids the `msw` peer dep that
// `simulateReadableStream` from `ai/test` pulls in at module load.
// Each chunk is enqueued in order; the stream closes cleanly.
function streamOf<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

// Minimal helper: run a streamText with the given mock, drain the
// stream, and return the full response. Streaming has to be drained
// before result.response resolves.
async function runStream(
  model: MockLanguageModelV2,
  messages: Parameters<typeof streamText>[0]["messages"],
) {
  const result = streamText({ model, messages });
  for await (const _ of result.fullStream) {
    // drain
  }
  return await result.response;
}

describe("AI SDK spike — thinking-block signature round-trip (v0.2.71 preflight)", () => {
  it("preserves Anthropic thinking signatures through response.messages and replays them on the next call", async () => {
    const SIGNATURE = "sig-spike-abc123-thinking-roundtrip";
    const THINKING_TEXT = "let me work through this step by step.";

    // Mock model emits a reasoning block (with signature in
    // providerMetadata.anthropic), some text, then finishes.
    const firstCallMock = new MockLanguageModelV2({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          {
            type: "reasoning-start",
            id: "r1",
            providerMetadata: { anthropic: { signature: SIGNATURE } },
          },
          { type: "reasoning-delta", id: "r1", delta: THINKING_TEXT },
          {
            type: "reasoning-end",
            id: "r1",
            providerMetadata: { anthropic: { signature: SIGNATURE } },
          },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Sure — here's my answer." },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          },
        ]),
      }),
    });

    const firstResponse = await runStream(firstCallMock, [
      { role: "user", content: "think about this" },
    ]);

    // STEP 1: response.messages should contain an assistant message
    // with a reasoning content part carrying the signature.
    const assistantMsg = firstResponse.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    if (!assistantMsg) throw new Error("no assistant message");
    const content = assistantMsg.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error("content not array");

    const reasoningPart = content.find((c) => c.type === "reasoning");
    expect(reasoningPart).toBeDefined();
    if (!reasoningPart || reasoningPart.type !== "reasoning") throw new Error("no reasoning part");

    expect(reasoningPart.text).toBe(THINKING_TEXT);
    // The signature lives under providerMetadata.anthropic.signature
    const sigInResponse =
      reasoningPart.providerOptions?.anthropic?.signature ??
      // The metadata key may be either providerOptions or providerMetadata
      // depending on direction (request vs response). Capture both.
      (reasoningPart as unknown as { providerMetadata?: { anthropic?: { signature?: string } } })
        .providerMetadata?.anthropic?.signature;
    expect(sigInResponse).toBe(SIGNATURE);

    // STEP 2: Call streamText AGAIN with the previous response.messages
    // as input. The mock records the prompt the SDK sends; we then
    // verify the assistant turn carries the reasoning content with
    // the SAME signature in providerMetadata.
    const secondCallMock = new MockLanguageModelV2({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ok" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      }),
    });

    await runStream(secondCallMock, [
      { role: "user", content: "think about this" },
      // Replay the response from the first call. The SDK
      // accepts the unified content shape OR the message format —
      // we pass the full content array, which is what
      // chat-runner would persist + replay in a real flow.
      ...firstResponse.messages,
      { role: "user", content: "and now answer this followup" },
    ]);

    // The mock captured the request. Inspect its first call — the
    // assistant turn in that prompt must have the reasoning content
    // with the signature so Anthropic's API would accept it.
    expect(secondCallMock.doStreamCalls.length).toBe(1);
    const promptSent = secondCallMock.doStreamCalls[0]!.prompt;
    const assistantInPrompt = promptSent.find((m) => m.role === "assistant");
    expect(assistantInPrompt).toBeDefined();
    if (!assistantInPrompt) throw new Error("assistant turn missing in second call's prompt");
    const replayedReasoning = (assistantInPrompt.content as unknown[]).find(
      (
        c,
      ): c is {
        type: "reasoning";
        text: string;
        providerOptions?: { anthropic?: { signature?: string } };
      } => typeof c === "object" && c !== null && (c as { type?: string }).type === "reasoning",
    );
    expect(replayedReasoning).toBeDefined();
    if (!replayedReasoning) throw new Error("reasoning content stripped from second-call prompt");
    expect(replayedReasoning.text).toBe(THINKING_TEXT);

    // The signature MUST be preserved verbatim — Anthropic verifies
    // it server-side on tool-use continuations and 400s if missing.
    const sigInReplay = replayedReasoning.providerOptions?.anthropic?.signature;
    expect(sigInReplay).toBe(SIGNATURE);
  });
});
