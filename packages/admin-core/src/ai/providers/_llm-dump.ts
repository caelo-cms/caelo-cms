// SPDX-License-Identifier: MPL-2.0

/**
 * Diagnostic wire-payload dump for LLM efficiency analysis. OFF unless
 * `CAELO_DUMP_LLM` names a writable file path. When on, every provider
 * generate() call appends ONE JSONL record capturing the EXACT semantic
 * request (system-prompt chunks, the tools array with full schemas, the
 * message history) alongside the real usage the provider reports back.
 *
 * This is an analysis aid, not a product feature: it lets us see, per
 * call, how the context budget is actually spent (base prompt vs tool
 * catalogue vs context blocks vs history) instead of guessing. Purely
 * additive — a missing/unset env var makes every hook a no-op, and a
 * write failure is swallowed so diagnostics can never break a chat.
 */

import { appendFileSync } from "node:fs";

import type { GenerateInput } from "../provider.js";

/** Rough token estimate. chars/4 matches the #300 context-split label so
 *  the two diagnostics read on the same scale; raw `chars` ships too so a
 *  precise tokenizer can be applied offline. */
export function estTokens(chars: number): number {
  return Math.round(chars / 4);
}

interface SizedPart {
  readonly label: string;
  readonly chars: number;
  readonly estTokens: number;
}

/** One captured provider call. */
export interface LlmDumpRecord {
  readonly seq: number;
  readonly model: string;
  readonly cacheBreakpoints: readonly string[];
  /** Per-system-chunk sizes (the ordered cache-prefix). */
  readonly systemChunks: readonly SizedPart[];
  /** Per-tool serialized sizes (name + full JSON schema). */
  readonly tools: readonly SizedPart[];
  readonly toolCount: number;
  /** Per-history-message sizes. */
  readonly messages: readonly SizedPart[];
  readonly totals: {
    readonly systemChars: number;
    readonly toolChars: number;
    readonly messageChars: number;
    readonly totalChars: number;
    readonly totalEstTokens: number;
  };
  /** What the provider actually billed for this call. */
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  readonly response: { textChars: number; toolCalls: readonly string[] };
  /** The full raw payload, so a component can be inspected verbatim
   *  offline (only written when CAELO_DUMP_LLM_FULL=1 to keep files small). */
  readonly raw?: {
    readonly system: unknown;
    readonly tools: unknown;
    readonly messages: unknown;
  };
}

let seq = 0;

function dumpPath(): string | null {
  const p = process.env.CAELO_DUMP_LLM;
  return p && p.trim().length > 0 ? p : null;
}

/** True when the dump is armed — lets callers skip building the record. */
export function llmDumpEnabled(): boolean {
  return dumpPath() !== null;
}

function sizeOf(label: string, value: unknown): SizedPart {
  const chars = typeof value === "string" ? value.length : JSON.stringify(value ?? "").length;
  return { label, chars, estTokens: estTokens(chars) };
}

/**
 * Build the sized record for one call. `sdkTools` is the post-transform
 * tools dictionary actually sent (so Tool-Search deferral, if on, shows
 * up as near-zero tool bytes). Pure — no I/O.
 */
export function buildLlmDumpRecord(args: {
  model: string;
  input: GenerateInput;
  sdkTools: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  responseText: string;
  toolCalls: readonly string[];
}): LlmDumpRecord {
  const { model, input, sdkTools, usage, responseText, toolCalls } = args;

  const systemChunks: SizedPart[] = Array.isArray(input.systemPrompt)
    ? input.systemPrompt.map((c, i) =>
        sizeOf(
          // SystemPromptChunk = { body, cacheable, label }.
          (c as { label?: string }).label ?? `chunk[${i}]`,
          (c as { body?: string }).body ?? c,
        ),
      )
    : [sizeOf("system(flat)", input.systemPrompt)];

  const tools: SizedPart[] = Object.entries(sdkTools).map(([name, def]) => sizeOf(name, def));

  const messages: SizedPart[] = input.messages.map((m, i) =>
    sizeOf(`${(m as { role?: string }).role ?? "msg"}[${i}]`, (m as { content?: unknown }).content),
  );

  const systemChars = systemChunks.reduce((a, s) => a + s.chars, 0);
  const toolChars = tools.reduce((a, s) => a + s.chars, 0);
  const messageChars = messages.reduce((a, s) => a + s.chars, 0);
  const totalChars = systemChars + toolChars + messageChars;

  const rec: LlmDumpRecord = {
    seq: seq++,
    model,
    cacheBreakpoints: (input.cacheBreakpoints ?? []) as readonly string[],
    systemChunks,
    tools,
    toolCount: tools.length,
    messages,
    totals: {
      systemChars,
      toolChars,
      messageChars,
      totalChars,
      totalEstTokens: estTokens(totalChars),
    },
    usage,
    response: { textChars: responseText.length, toolCalls },
    ...(process.env.CAELO_DUMP_LLM_FULL === "1"
      ? { raw: { system: input.systemPrompt, tools: sdkTools, messages: input.messages } }
      : {}),
  };
  return rec;
}

/** Append one record as a JSONL line. No-op when disarmed; never throws. */
export function writeLlmDump(rec: LlmDumpRecord): void {
  const p = dumpPath();
  if (!p) return;
  try {
    appendFileSync(p, `${JSON.stringify(rec)}\n`);
  } catch {
    // diagnostics must never break a chat turn
  }
}
