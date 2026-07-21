// SPDX-License-Identifier: MPL-2.0

/**
 * issue #261 — provider-history compaction so a chat session can run
 * indefinitely without dying at the model's context ceiling (run #7:
 * "prompt is too long: 1202876 tokens > 1000000 maximum", terminal —
 * every subsequent turn repeated the error with no in-chat recovery).
 *
 * Everything here is PURE and operates only on the in-memory
 * `ChatMessageInput[]` sent to the provider. The persisted
 * `chat_messages` transcript is never touched — the operator's chat log
 * stays complete; only what rides to the model shrinks.
 *
 * Compaction order (cheapest information loss first):
 *   1. Truncate OLD tool-result messages down to a short head plus a
 *      `[truncated: N chars]` marker. Tool results dominate long
 *      sessions (40KB HTML module dumps) and their full bodies are
 *      almost never needed again once the model has acted on them.
 *   2. If still over target, replace the oldest conversation span with
 *      ONE deterministic digest message (roles, tool names, first
 *      lines). Deliberately NOT an AI-generated summary: a
 *      summarization call over a ~600k-token history costs real money
 *      per compaction and can itself exceed the context window — the
 *      digest is free, deterministic, and unit-testable. Epic #264
 *      moves rich summarization to subagent result summaries instead.
 *
 * Never compacted away:
 *   - the most recent `keepRecentMessages` messages (working context);
 *   - the latest user message (the instruction being acted on);
 *   - the latest assistant message, including its thinking blocks —
 *     Anthropic verifies thinking signatures on replay and rejects a
 *     stripped/altered last assistant turn with HTTP 400;
 *   - tool_use/tool_result pairing — a kept tool result whose
 *     assistant tool_use was summarized away is a provider-side 400,
 *     so the digest span never ends between an assistant tool_use and
 *     its trailing tool results.
 *
 * Open proposal/approval context is safe by construction: pending
 * proposals ride in the system prompt (§11.A "Your pending proposals"
 * block), not in history, and the digest preserves tool names so
 * `*.propose_*` calls remain visible in the compacted trail.
 */

import type { ChatMessageInput } from "../provider.js";

/** chars/4 — the standard rough heuristic for English + JSON + HTML. */
const CHARS_PER_TOKEN = 4;

/**
 * Flat per-image estimate. Provider image tokenization is
 * resolution-based (Anthropic caps around ~1600 tokens per image);
 * counting base64 chars/4 would overestimate ~100x and trigger
 * compaction on every screenshot-bearing turn.
 */
const IMAGE_PART_TOKENS = 1600;

/**
 * chars/4 overcounts real provider input tokens by ~1.66× (measured
 * across e2e-livedit runs: a history the estimator scores at ~1.33M
 * corresponds to ~800K real Anthropic input tokens). Compaction reasons
 * in REAL tokens — the thing that actually fills the 1M window — but
 * operates on the chars/4 estimate, so every real-token budget below is
 * scaled by this ratio before it meets the estimator.
 */
export const ESTIMATE_OVERCOUNT_RATIO = 1.66;

/** Convert a real-token budget into the chars/4 estimate space compaction runs in. */
function realToEstimate(realTokens: number): number {
  return Math.round(realTokens * ESTIMATE_OVERCOUNT_RATIO);
}

/**
 * Compaction fires once the estimated prefix crosses ~800K REAL input
 * tokens — deliberately late, near the 1M window. The old default (600K
 * estimate ≈ 360K real) fired early AND only compacted down to itself, so
 * it re-fired every few loops and rewrote the cached prefix each time.
 * Firing late and dropping HARD (see the target below) trades that for a
 * single cache-invalidating rewrite per long stretch. Env-tunable (in
 * estimate space) via CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS.
 */
export const COMPACTION_TRIGGER_REAL_TOKENS = 800_000;
export const COMPACTION_THRESHOLD_TOKENS_DEFAULT = realToEstimate(COMPACTION_TRIGGER_REAL_TOKENS);

/**
 * When compaction fires it lands the history at ~200K REAL tokens: the
 * recent tail (see below) kept verbatim, everything older crushed to a
 * digest + truncated heads. Far below the previous "compact down to the
 * trigger" behaviour, so the next compaction is hundreds of K of headroom
 * away — few rewrites, long cache-hit runs in between.
 * Env-tunable via CAELO_CHAT_COMPACTION_TARGET_TOKENS.
 */
export const COMPACTION_TARGET_REAL_TOKENS = 200_000;
export const COMPACTION_TARGET_TOKENS_DEFAULT = realToEstimate(COMPACTION_TARGET_REAL_TOKENS);

/**
 * The recent tail kept verbatim through a compaction: ~100K REAL tokens.
 * A token budget, not a fixed message count — a 10-message tail can be 5K
 * or 400K tokens depending on how many tool dumps it holds, and the
 * operator's mental model is "keep the last ~100K of conversation", not
 * "keep the last 10 messages". {@link recentTailCount} resolves this to a
 * message count against the live history.
 * Env-tunable via CAELO_CHAT_COMPACTION_RECENT_TOKENS.
 */
export const COMPACTION_RECENT_REAL_TOKENS = 100_000;
export const COMPACTION_RECENT_TOKENS_DEFAULT = realToEstimate(COMPACTION_RECENT_REAL_TOKENS);

/**
 * Floor for the recent-tail window: even if the last message alone
 * exceeds the recent-token budget, keep at least this many so the latest
 * user+assistant exchange and its tool pair survive verbatim.
 */
export const MIN_RECENT_MESSAGES = 4;

/** Messages at the tail that the prompt-too-long retry pass must never modify or drop. */
export const KEEP_RECENT_MESSAGES = 10;

/** Head kept when truncating a tool result in the routine pass. */
export const TOOL_RESULT_HEAD_CHARS = 500;

/**
 * Head kept on the harder pass after a live "prompt is too long"
 * provider rejection — the routine head clearly wasn't enough.
 */
export const RETRY_TOOL_RESULT_HEAD_CHARS = 200;

/**
 * Provider messages that mean "the request exceeded the model's
 * context window". Anthropic: "prompt is too long: N tokens > M
 * maximum". OpenAI: "maximum context length" / code
 * `context_length_exceeded`. Kept deliberately narrow — matching a
 * transient error here would burn the single retry on the wrong
 * failure class.
 */
const PROMPT_TOO_LONG_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /maximum context length/i,
  /context[_ -]length[_ -]exceeded/i,
  /exceeds? (?:the )?context (?:limit|window)/i,
  /input is too long/i,
];

/** True when a provider error message signals a context-window overflow. */
export function isPromptTooLongError(message: string): boolean {
  return PROMPT_TOO_LONG_PATTERNS.some((p) => p.test(message));
}

/**
 * Extract the model's token ceiling from an Anthropic-style
 * "prompt is too long: N tokens > M maximum" message, so the retry
 * pass can target a size that actually fits models with windows
 * smaller than the default threshold. Null when the message carries
 * no parseable limit.
 */
export function parsePromptTooLongLimit(message: string): number | null {
  const m = /(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i.exec(message);
  if (!m?.[2]) return null;
  const limit = Number.parseInt(m[2], 10);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/**
 * Resolve the compaction trigger threshold, honouring the
 * CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS env override. A set-but-
 * unparseable value throws (CLAUDE.md §2 — fail loudly, don't silently
 * fall back to the default and mask the operator's misconfiguration).
 */
export function resolveCompactionThresholdTokens(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS;
  if (raw === undefined || raw === "") return COMPACTION_THRESHOLD_TOKENS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS is set to ${JSON.stringify(raw)} — expected a positive integer token count`,
    );
  }
  return parsed;
}

/** Shared parse+validate for the positive-integer token-count env knobs below. */
function resolvePositiveIntEnv(
  envName: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${envName} is set to ${JSON.stringify(raw)} — expected a positive integer token count`,
    );
  }
  return parsed;
}

/**
 * Estimate-space landing target for a fired compaction, honouring
 * CAELO_CHAT_COMPACTION_TARGET_TOKENS. See {@link COMPACTION_TARGET_TOKENS_DEFAULT}.
 */
export function resolveCompactionTargetTokens(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolvePositiveIntEnv(
    "CAELO_CHAT_COMPACTION_TARGET_TOKENS",
    env.CAELO_CHAT_COMPACTION_TARGET_TOKENS,
    COMPACTION_TARGET_TOKENS_DEFAULT,
  );
}

/**
 * Estimate-space recent-tail budget kept verbatim through a compaction,
 * honouring CAELO_CHAT_COMPACTION_RECENT_TOKENS. See {@link COMPACTION_RECENT_TOKENS_DEFAULT}.
 */
export function resolveCompactionRecentTokens(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolvePositiveIntEnv(
    "CAELO_CHAT_COMPACTION_RECENT_TOKENS",
    env.CAELO_CHAT_COMPACTION_RECENT_TOKENS,
    COMPACTION_RECENT_TOKENS_DEFAULT,
  );
}

/**
 * Whether the issue #300 proactive per-loop tool-result compaction is
 * enabled. Default OFF: it rewrites OLD tool results (deep in the cached
 * prefix) on nearly every loop, so it invalidates the message cache
 * continuously — the exact cost the single-shot ceiling compaction was
 * retuned to avoid. Opt back in with CAELO_CHAT_PROACTIVE_COMPACTION=1
 * for a run that is latency-bound within one turn rather than cache-bound.
 */
export function resolveProactiveCompaction(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.CAELO_CHAT_PROACTIVE_COMPACTION;
  return raw === "1" || raw === "true";
}

/** Rough token estimate for a plain string — chars/4 (issue #300 telemetry shares this heuristic). */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Rough token estimate for one provider message: chars/4 over content
 * + tool-call JSON + thinking text, plus a flat per-image constant.
 * Thinking signatures are excluded — they're opaque ~100-char blobs,
 * negligible next to the text they sign.
 */
export function estimateMessageTokens(m: ChatMessageInput): number {
  let chars = m.content.length;
  if (m.toolCalls && m.toolCalls.length > 0) chars += JSON.stringify(m.toolCalls).length;
  for (const tb of m.thinkingBlocks ?? []) chars += tb.thinking.length;
  let tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  for (const part of m.additionalContent ?? []) {
    tokens +=
      part.type === "image" ? IMAGE_PART_TOKENS : Math.ceil(part.text.length / CHARS_PER_TOKEN);
  }
  return tokens;
}

/** Sum of {@link estimateMessageTokens} across the history. */
export function estimateHistoryTokens(messages: readonly ChatMessageInput[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * How many tail messages fit within `recentTokenBudget` (estimate space)
 * — the "keep verbatim" window for a compaction, expressed as a token
 * budget rather than a fixed message count. Walks from the newest message
 * backwards, stopping before the running total would exceed the budget,
 * so a single oversized older message (a fresh 400K HTML dump) falls
 * OUTSIDE the protected tail and is eligible for truncation. Always keeps
 * at least {@link MIN_RECENT_MESSAGES} (pairing safety) and never more
 * than the history length.
 */
export function recentTailCount(
  messages: readonly ChatMessageInput[],
  recentTokenBudget: number,
): number {
  let sum = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i]!);
    // Always admit the newest message; stop once the NEXT would overflow.
    if (count > 0 && sum + t > recentTokenBudget) break;
    sum += t;
    count++;
  }
  return Math.min(messages.length, Math.max(MIN_RECENT_MESSAGES, count));
}

export interface CompactionOptions {
  /** Compact until the estimated history size is at or below this. */
  readonly targetTokens: number;
  /** Tail window compaction must never modify (default {@link KEEP_RECENT_MESSAGES}). */
  readonly keepRecentMessages: number;
  /** Chars of each truncated tool result to keep as the head. */
  readonly toolResultHeadChars: number;
}

export interface CompactionResult {
  readonly messages: ChatMessageInput[];
  /** Stage-1 count: old tool results shortened to head + marker. */
  readonly toolResultsTruncated: number;
  /** Stage-2 count: messages folded into the single digest message. */
  readonly summarizedMessages: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
}

/**
 * Marker appended to a truncated tool result; `n` = chars removed.
 * Exported (issue #300) so the proactive per-loop compaction emits the
 * SAME marker format — one vocabulary for "this result was shortened",
 * whoever shortened it.
 */
export function truncationMarker(n: number): string {
  return `\n[truncated: ${n} chars]`;
}

/**
 * True when a tool-result body already ends with the truncation marker
 * (cut by the #261 ceiling pass or the #300 proactive pass). The
 * proactive pass never re-compacts a marked result.
 */
export function hasTruncationMarker(content: string): boolean {
  return /\[truncated: \d+ chars\]\s*$/.test(content);
}

/**
 * Truncation must save at least this many chars to be worth it. Also
 * what makes truncation idempotent: a result already cut to
 * head+marker is within this margin of the head size, so a second
 * pass at the same head skips it instead of shaving the marker.
 */
const MIN_TRUNCATION_SAVINGS_CHARS = 200;

/** Digest lines are capped so a 1000-message span can't mint a huge digest. */
const MAX_DIGEST_LINES = 80;
const DIGEST_LINE_CHARS = 100;

function digestLine(m: ChatMessageInput): string {
  const firstLine = m.content.split("\n", 1)[0] ?? "";
  const excerpt =
    firstLine.length > DIGEST_LINE_CHARS ? `${firstLine.slice(0, DIGEST_LINE_CHARS)}…` : firstLine;
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    const names = m.toolCalls.map((c) => c.name).join(", ");
    return `- assistant [tools: ${names}]: ${excerpt}`;
  }
  return `- ${m.role}: ${excerpt}`;
}

/**
 * Deterministic digest of a summarized span: one line per message
 * (role, tool names, first line of content), middle elided past
 * {@link MAX_DIGEST_LINES}. See the file header for why this is not an
 * AI-generated summary.
 */
export function buildSpanDigest(span: readonly ChatMessageInput[]): string {
  const header =
    `[History compacted to fit the model's context window: the ${span.length} earliest ` +
    `messages of this conversation were replaced by this digest. The full transcript is ` +
    `still in the chat log. Digest:]`;
  let lines: string[];
  if (span.length <= MAX_DIGEST_LINES) {
    lines = span.map(digestLine);
  } else {
    const headCount = Math.ceil(MAX_DIGEST_LINES / 2);
    const tailCount = MAX_DIGEST_LINES - headCount;
    lines = [
      ...span.slice(0, headCount).map(digestLine),
      `… [${span.length - MAX_DIGEST_LINES} more messages elided] …`,
      ...span.slice(span.length - tailCount).map(digestLine),
    ];
  }
  return [header, ...lines].join("\n");
}

/**
 * Compact `messages` toward `opts.targetTokens` using the two-stage
 * strategy described in the file header. Pure: returns new arrays/
 * objects, never mutates the input. May return a history still over
 * target when the protected tail alone exceeds it — callers handle
 * that via the prompt-too-long retry/notice path in loop.ts.
 */
export function compactHistory(
  messages: readonly ChatMessageInput[],
  opts: CompactionOptions,
): CompactionResult {
  const estimatedTokensBefore = estimateHistoryTokens(messages);
  const out: ChatMessageInput[] = [...messages];
  const firstProtectedIdx = Math.max(0, out.length - opts.keepRecentMessages);
  let estimate = estimatedTokensBefore;
  let toolResultsTruncated = 0;

  // Stage 1 — truncate old tool results, oldest first, until under target.
  for (let i = 0; i < firstProtectedIdx && estimate > opts.targetTokens; i++) {
    const m = out[i];
    if (!m || m.role !== "tool") continue;
    const removed = m.content.length - opts.toolResultHeadChars;
    // Skip results at/near the head size — including previously
    // truncated ones, unless this pass uses a materially smaller head
    // (the harder retry pass re-cuts a 500-char head down to 200).
    if (removed <= MIN_TRUNCATION_SAVINGS_CHARS) continue;
    const truncated: ChatMessageInput = {
      ...m,
      content: `${m.content.slice(0, opts.toolResultHeadChars)}${truncationMarker(removed)}`,
    };
    estimate -= estimateMessageTokens(m) - estimateMessageTokens(truncated);
    out[i] = truncated;
    toolResultsTruncated++;
  }

  // Stage 2 — fold the oldest span into a single digest message.
  let summarizedMessages = 0;
  if (estimate > opts.targetTokens) {
    let spanEnd = out.length - opts.keepRecentMessages;
    // The latest user message and the latest assistant message (with
    // its signature-bearing thinking blocks) must survive even when a
    // long tool run pushed them past the recent-tail window.
    const lastUserIdx = out.findLastIndex((m) => m.role === "user");
    const lastAssistantIdx = out.findLastIndex((m) => m.role === "assistant");
    if (lastUserIdx >= 0) spanEnd = Math.min(spanEnd, lastUserIdx);
    if (lastAssistantIdx >= 0) spanEnd = Math.min(spanEnd, lastAssistantIdx);
    // Pairing integrity: the first KEPT message must not be a tool
    // result whose assistant tool_use fell inside the span. Walk back
    // to the owning assistant message so the pair stays together.
    while (spanEnd > 0 && out[spanEnd]?.role === "tool") spanEnd--;
    // A 0/1-message span gains nothing — the digest would replace a
    // single message with roughly the same amount of text.
    if (spanEnd > 1) {
      const span = out.slice(0, spanEnd);
      out.splice(0, spanEnd, { role: "user", content: buildSpanDigest(span) });
      summarizedMessages = spanEnd;
    }
  }

  return {
    messages: out,
    toolResultsTruncated,
    summarizedMessages,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateHistoryTokens(out),
  };
}
