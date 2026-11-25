// SPDX-License-Identifier: MPL-2.0

/**
 * A scripted language model for the visitor AI's tests (#1654) and for the
 * browser fixture of a site assistant (#1655): the AI SDK's own
 * `MockLanguageModelV4`, never a real provider or key.
 *
 * It behaves like a well-behaved model with the conversation's tools: on a
 * question it calls the first search tool with the question's words; once a
 * search result came back it answers from the first result, citing it as
 * `[n]`. `script` overrides either step (an injected page that "asks" for a
 * write tool, an answer that invents a link, …). Every call is recorded,
 * with the tool names the gateway offered, so a test can prove what the
 * model could reach.
 *
 * Install it with `setVisitorAiModelFactoryForTests(() => model)`
 * (provider.ts).
 */

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

/** One recorded model call. */
export interface ScriptedCall {
  /** The tool names the gateway offered the model. */
  readonly tools: readonly string[];
  /** The system prompt and messages, as text. */
  readonly prompt: string;
}

/** What one step answers: text, or tool calls (input as an object). */
export type ScriptedStep =
  | { readonly text: string }
  | { readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[] };

/** Overrides of the default behaviour. */
export interface Script {
  /** The first step of a turn (default: search the question's words). */
  readonly onQuestion?: (question: string, tools: readonly string[]) => ScriptedStep;
  /** A step after tool results (default: answer from the first source). */
  readonly onToolResult?: (results: readonly string[], question: string) => ScriptedStep;
  /** Tokens each step reports (default 400 in, 60 out). */
  readonly usage?: { readonly input: number; readonly output: number };
  /** Milliseconds each step takes before it answers (default 0). */
  readonly delayMs?: number;
}

type PromptMessage = { role: string; content: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const part = p as {
        type?: string;
        text?: string;
        output?: { type?: string; value?: unknown };
      };
      if (part.type === "text") return part.text ?? "";
      if (part.type === "tool-result")
        return typeof part.output?.value === "string"
          ? part.output.value
          : JSON.stringify(part.output?.value ?? "");
      return "";
    })
    .join("\n");
}

function defaultAnswer(results: readonly string[]): ScriptedStep {
  for (const r of results) {
    try {
      const parsed = JSON.parse(r) as {
        results?: { source?: number; title?: string; snippet?: string }[];
      };
      const first = parsed.results?.[0];
      if (first?.source)
        return {
          text: `${first.title ?? "Die Seite"}: ${first.snippet ?? ""} [${first.source}]`.trim(),
        };
    } catch {
      // not JSON: try the next one
    }
  }
  return { text: "Dazu habe ich auf dieser Website nichts gefunden." };
}

function partsOf(
  step: ScriptedStep,
  usage: { input: number; output: number },
): LanguageModelV4StreamPart[] {
  const finishUsage = {
    inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: usage.output, text: usage.output, reasoning: 0 },
  };
  if ("text" in step) {
    // Streamed in a few pieces, as a provider does.
    const words = step.text.split(/(?<= )/);
    return [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      ...words.map((w) => ({ type: "text-delta" as const, id: "t", delta: w })),
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: finishUsage },
    ] as LanguageModelV4StreamPart[];
  }
  return [
    { type: "stream-start", warnings: [] },
    ...step.toolCalls.map((c, i) => ({
      type: "tool-call" as const,
      toolCallId: `call-${i}-${Math.random().toString(36).slice(2, 8)}`,
      toolName: c.name,
      input: JSON.stringify(c.input),
    })),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: finishUsage,
    },
  ] as LanguageModelV4StreamPart[];
}

/** A scripted model and the calls it received. */
export function scriptedVisitorModel(script: Script = {}): {
  readonly model: MockLanguageModelV4;
  readonly calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const usage = script.usage ?? { input: 400, output: 60 };
  const model = new MockLanguageModelV4({
    provider: "scripted",
    modelId: "scripted-visitor-model",
    doStream: async (options) => {
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      const prompt = options.prompt as unknown as PromptMessage[];
      const tools = (options.tools ?? []).map((t) => (t as { name: string }).name);
      calls.push({
        tools,
        prompt: prompt.map((m) => `${m.role}: ${textOf(m.content)}`).join("\n"),
      });
      const lastUser = [...prompt].reverse().find((m) => m.role === "user");
      const question = textOf(lastUser?.content);
      const tail: PromptMessage[] = [];
      for (let i = prompt.length - 1; i >= 0 && prompt[i]?.role === "tool"; i--)
        tail.unshift(prompt[i] as PromptMessage);
      let step: ScriptedStep;
      if (tail.length > 0) {
        const results = tail.map((m) => textOf(m.content));
        step = script.onToolResult
          ? script.onToolResult(results, question)
          : defaultAnswer(results);
      } else if (script.onQuestion) {
        step = script.onQuestion(question, tools);
      } else {
        const search = tools.find((t) => t.endsWith("__search"));
        step = search
          ? {
              toolCalls: [
                { name: search, input: { query: question.split(/\s+/).slice(0, 6).join(" ") } },
              ],
            }
          : { text: "Dazu habe ich auf dieser Website nichts gefunden." };
      }
      return { stream: convertArrayToReadableStream(partsOf(step, usage)) };
    },
  });
  return { model, calls };
}
